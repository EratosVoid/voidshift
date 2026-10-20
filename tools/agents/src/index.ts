import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsDir, lookup, readAgentsConfig, writeAgentsConfig } from './config.ts';
import { promptLinearKey, readLinearKey } from './keychain.ts';
import { runnerLoaded, startRunner, stopRunner } from './launchd.ts';
import { createLinear } from './linear.ts';
import { tick } from './runner.ts';
import type { Check, Tool, ToolContext } from './types.ts';

const packDir = fileURLToPath(new URL('../pack/', import.meta.url));
const packNames = () => readdirSync(packDir).filter((n) => existsSync(join(packDir, n, 'SKILL.md')));

// Where each agent CLI looks for user-level skills.
function skillDirs(): { name: string; dir: string; present: boolean }[] {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const has = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
  return [
    { name: 'Claude Code', dir: join(claudeHome, 'skills'), present: has('claude') },
    { name: 'Codex', dir: join(codexHome, 'skills'), present: has('codex') },
  ];
}

const isOurLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(readlinkSync(path)).startsWith(resolve(packDir));
  } catch {
    return false;
  }
};

function linkPack(log: (l: string) => void): void {
  for (const target of skillDirs().filter((t) => t.present)) {
    mkdirSync(target.dir, { recursive: true });
    for (const name of packNames()) {
      const dest = join(target.dir, name);
      if (existsSync(dest) || isOurLink(dest)) {
        if (isOurLink(dest)) continue;
        log(`Skipped ${name} in ${target.name}: something else is already at ${dest}`);
        continue;
      }
      symlinkSync(join(packDir, name), dest);
    }
    log(`Agents linked into ${target.name} (${target.dir})`);
  }
}

function linear() {
  const key = readLinearKey();
  if (!key) throw new Error('No Linear API key. Run voidshift agents key');
  return createLinear(key);
}

const usage = `voidshift agents <command>
  status                     What is set up and running
  repo <TEAM|Project> <path> Map Linear cards to a local repo
  ui <TEAM|Project> <url>    Where the app runs, for the browser check
  engine <claude|codex>      Which agent CLI runs the background chain
  key                        Store or replace the Linear API key
  run [CARD]                 Run the chain once now, in this terminal
  start | stop               Start or stop the background runner`;

const agents: Tool = {
  name: 'agents',
  summary: 'Agents for Claude Code and Codex that plan, build and QA Linear cards',

  async install(ctx) {
    if (!skillDirs().some((t) => t.present)) throw new Error('install Claude Code or Codex first');
    linkPack(ctx.log);
    if (!readLinearKey()) {
      ctx.log('The background runner needs a Linear personal API key (Linear > Settings > Security & access).');
      ctx.log('Paste it when asked; it goes into your macOS Keychain:');
      if (!promptLinearKey()) throw new Error('could not store the Linear key');
    }
    const me = await linear().viewer();
    writeAgentsConfig(ctx.configDir, readAgentsConfig(ctx.configDir));
    ctx.log(`Linear connected as ${me.name}.`);
    ctx.log('Next: voidshift agents repo <TEAM> <path>, then voidshift agents start');
    ctx.log('Interactive agents (vs-plan, vs-publish) also need Linear connected inside Claude Code or Codex.');
  },

  async uninstall(ctx) {
    stopRunner(ctx.home);
    for (const target of skillDirs()) for (const name of packNames()) {
      const dest = join(target.dir, name);
      if (isOurLink(dest)) rmSync(dest);
    }
    ctx.log('Agents unlinked and the runner stopped. Config and the Linear key were kept.');
  },

  async checks(ctx): Promise<Check[]> {
    const checks: Check[] = [];
    for (const t of skillDirs().filter((t) => t.present)) {
      const missing = packNames().filter((n) => !isOurLink(join(t.dir, n)));
      checks.push(
        missing.length === 0
          ? { name: `agents in ${t.name}`, status: 'ok', detail: `${packNames().length} linked` }
          : { name: `agents in ${t.name}`, status: 'warn', detail: `missing ${missing.join(', ')}`, fix: 'voidshift add agents' },
      );
    }
    try {
      const me = await linear().viewer();
      checks.push({ name: 'Linear', status: 'ok', detail: `connected as ${me.name}` });
    } catch (err) {
      checks.push({ name: 'Linear', status: 'fail', detail: (err as Error).message, fix: 'voidshift agents key' });
    }
    const config = readAgentsConfig(ctx.configDir);
    const repos = Object.keys(config.repos).length;
    checks.push(
      repos
        ? { name: 'agent repos', status: 'ok', detail: `${repos} mapped` }
        : { name: 'agent repos', status: 'warn', detail: 'none mapped', fix: 'voidshift agents repo <TEAM> <path>' },
    );
    checks.push(
      runnerLoaded()
        ? { name: 'agent runner', status: 'ok', detail: 'polling Linear every minute' }
        : { name: 'agent runner', status: 'warn', detail: 'not running', fix: 'voidshift agents start' },
    );
    return checks;
  },

  commands: {
    async status(_args, ctx) {
      const c = readAgentsConfig(ctx.configDir);
      ctx.log(`Engine: ${c.engine}  models: dev ${c.models.dev ?? 'default'}, review ${c.models.review ?? 'default'}, ui ${c.models.ui ?? 'default'}`);
      ctx.log(`Rounds before parking: ${c.maxRounds}`);
      ctx.log(`Repos: ${Object.entries(c.repos).map(([k, v]) => `${k} -> ${v}`).join(', ') || 'none'}`);
      ctx.log(`Browser check URLs: ${Object.entries(c.uiUrls).map(([k, v]) => `${k} -> ${v}`).join(', ') || 'none (browser QA skipped)'}`);
      ctx.log(`Runner: ${runnerLoaded() ? 'running' : 'stopped'}${existsSync(join(agentsDir(ctx.configDir), 'runner.lock')) ? ', working on a card now' : ''}`);
      return 0;
    },

    async repo(args, ctx) {
      const [key, path] = args;
      if (!key || !path) {
        ctx.log('usage: voidshift agents repo <TEAM|Project> <path>');
        return 2;
      }
      const full = resolve(path);
      if (!existsSync(join(full, '.git'))) {
        ctx.log(`${full} is not a git repository.`);
        return 1;
      }
      const c = readAgentsConfig(ctx.configDir);
      c.repos[key] = full;
      writeAgentsConfig(ctx.configDir, c);
      ctx.log(`${key} cards now build in ${full}`);
      return 0;
    },

    async ui(args, ctx) {
      const [key, url] = args;
      if (!key || !url || !/^https?:\/\//.test(url)) {
        ctx.log('usage: voidshift agents ui <TEAM|Project> <http://url>');
        return 2;
      }
      const c = readAgentsConfig(ctx.configDir);
      c.uiUrls[key] = url;
      writeAgentsConfig(ctx.configDir, c);
      ctx.log(`Browser QA for ${key} will use ${url}`);
      return 0;
    },

    async engine(args, ctx) {
      const engine = args[0];
      if (engine !== 'claude' && engine !== 'codex') {
        ctx.log('usage: voidshift agents engine <claude|codex>');
        return 2;
      }
      const c = readAgentsConfig(ctx.configDir);
      c.engine = engine;
      if (engine === 'codex') c.models = {};
      writeAgentsConfig(ctx.configDir, c);
      ctx.log(`Background chain now runs on ${engine}.`);
      return 0;
    },

    async key(_args, ctx) {
      ctx.log('Paste your Linear personal API key:');
      return promptLinearKey() ? 0 : 1;
    },

    async run(args, ctx) {
      const config = readAgentsConfig(ctx.configDir);
      const code = await tick({ configDir: ctx.configDir, config, linear: linear(), log: ctx.log }, args[0]);
      if (!args[0] && code === 0) ctx.log('Nothing to do, or the card was verified.');
      return code;
    },

    // Run by launchd every minute.
    async tick(_args, ctx) {
      const config = readAgentsConfig(ctx.configDir);
      const log = (l: string) => ctx.log(`${new Date().toISOString()} ${l}`);
      return tick({ configDir: ctx.configDir, config, linear: linear(), log });
    },

    async start(_args, ctx) {
      if (!Object.keys(readAgentsConfig(ctx.configDir).repos).length) {
        ctx.log('Map a repo first: voidshift agents repo <TEAM> <path>');
        return 1;
      }
      const ok = startRunner(ctx.home, [...ctx.selfCommand, 'agents', 'tick'], join(agentsDir(ctx.configDir), 'runner.log'));
      ctx.log(ok ? 'Runner started. It checks Linear every minute for your cards labelled vs-plan.' : 'Could not start the runner.');
      return ok ? 0 : 1;
    },

    async stop(_args, ctx) {
      stopRunner(ctx.home);
      ctx.log('Runner stopped. A card in progress is left where it is.');
      return 0;
    },

    async help(_args, ctx) {
      ctx.log(usage);
      return 0;
    },
  },
};

export { lookup };
export default agents;
