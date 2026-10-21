import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsDir, lookup, readAgentsConfig, writeAgentsConfig } from './config.ts';
import { looksLikeLinearKey, readLinearKey, storeLinearKey } from './keychain.ts';
import { runnerLoaded, startRunner, stopRunner } from './launchd.ts';
import { createLinear } from './linear.ts';
import { tick } from './runner.ts';
import type { Check, Tool, ToolContext, Ui } from './types.ts';

const packDir = fileURLToPath(new URL('../pack/', import.meta.url));
const packNames = () => readdirSync(packDir).filter((n) => existsSync(join(packDir, n, 'SKILL.md')));

type Home = { kind: 'claude' | 'codex'; dir: string };

const has = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const tilde = (p: string) => p.replace(homedir(), '~');
const homeLabel = (h: Home) => `${h.kind === 'claude' ? 'Claude Code' : 'Codex'}  ${tilde(h.dir)}`;

// Config folders that could hold the agents: Claude Code reads
// CLAUDE_CONFIG_DIR or ~/.claude, Codex reads CODEX_HOME or ~/.codex, plus any
// folder chosen before.
function candidateHomes(saved: Home[]): Home[] {
  const found: Home[] = [];
  if (has('claude')) {
    for (const d of [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]) if (d) found.push({ kind: 'claude', dir: resolve(d) });
  }
  if (has('codex')) found.push({ kind: 'codex', dir: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')) });
  const all = [...saved, ...found];
  return all.filter((h, i) => all.findIndex((o) => o.dir === h.dir) === i);
}

// Before a choice is saved, tick only the folder Claude Code is using right
// now (or Codex when Claude is not installed). More is one keypress away.
function defaultHomes(candidates: Home[]): Home[] {
  const first = candidates.find((h) => h.kind === 'claude') ?? candidates.find((h) => h.kind === 'codex');
  return first ? [first] : [];
}

async function chooseHomes(ui: Ui, saved: Home[]): Promise<Home[]> {
  const candidates = candidateHomes(saved);
  const initial = (saved.length ? saved : defaultHomes(candidates)).map((h) => h.dir);
  const OTHER = '__other__';
  const picked = await ui.multiselect(
    'Install the agents into which Claude Code / Codex folders?',
    [...candidates.map((h) => ({ value: h.dir, label: homeLabel(h) })), { value: OTHER, label: 'Another Claude Code folder...' }],
    initial,
  );
  const homes = candidates.filter((h) => picked.includes(h.dir));
  if (picked.includes(OTHER)) {
    const dir = await ui.text('Path to the Claude Code config folder (the one with settings.json)', {
      placeholder: '~/work/claude',
      validate: (v) => (existsSync(expandHome(v.trim())) ? undefined : 'That folder does not exist'),
    });
    homes.push({ kind: 'claude', dir: resolve(expandHome(dir.trim())) });
  }
  return homes;
}

// Asks for the key, checks it against Linear, and only then stores it.
async function setupKey(ui: Ui): Promise<string | null> {
  ui.info('Agents need a Linear personal API key (Linear > Settings > Security & access > API keys).');
  const key = await ui.secret('Paste your Linear API key', (v) => (looksLikeLinearKey(v.trim()) ? undefined : 'Linear keys start with lin_api_'));
  try {
    const me = await createLinear(key.trim()).viewer();
    if (!storeLinearKey(key.trim())) {
      ui.warn('Linear accepted the key but the Keychain did not store it.');
      return null;
    }
    ui.info(`Linear connected as ${me.name}. Key stored in your macOS Keychain.`);
    return me.name;
  } catch (err) {
    ui.warn(`Linear did not accept that key: ${(err as Error).message}. Nothing was stored.`);
    return null;
  }
}

async function currentLinearUser(): Promise<string | null> {
  try {
    return readLinearKey() ? (await linear().viewer()).name : null;
  } catch {
    return null;
  }
}

const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const isOurLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(readlinkSync(path)).startsWith(resolve(packDir));
  } catch {
    return false;
  }
};

// Links every agent into each chosen home and removes our links from the rest.
function syncLinks(chosen: Home[], all: Home[], log: (l: string) => void): void {
  for (const home of all) {
    const skills = join(home.dir, 'skills');
    const wanted = chosen.some((h) => h.dir === home.dir);
    if (!wanted) {
      for (const name of packNames()) if (isOurLink(join(skills, name))) rmSync(join(skills, name));
      continue;
    }
    mkdirSync(skills, { recursive: true });
    for (const name of packNames()) {
      const dest = join(skills, name);
      if (isOurLink(dest)) continue;
      if (existsSync(dest)) {
        log(`Skipped ${name} in ${tilde(home.dir)}: something else is already there`);
        continue;
      }
      symlinkSync(join(packDir, name), dest);
    }
    log(`Agents installed in ${homeLabel(home)}`);
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
    const { ui } = ctx;
    const config = readAgentsConfig(ctx.configDir);
    if (!candidateHomes(config.homes).length) throw new Error('install Claude Code or Codex first');

    const homes = await chooseHomes(ui, config.homes);
    if (!homes.length) throw new Error('pick at least one folder to install the agents into');
    syncLinks(homes, candidateHomes([...config.homes, ...homes]), ctx.log);
    config.homes = homes;

    const engines = [...new Set(homes.map((h) => h.kind))];
    const engine =
      engines.length === 1
        ? engines[0]!
        : await ui.select(
            'Which one should run the background agents?',
            [
              { value: 'claude', label: 'Claude Code', hint: 'your Claude subscription' },
              { value: 'codex', label: 'Codex', hint: 'your ChatGPT subscription' },
            ],
            config.engine,
          );
    if (engine !== config.engine) config.models = engine === 'codex' ? {} : { dev: 'opus', review: 'sonnet', ui: 'sonnet' };
    config.engine = engine;

    const name = await currentLinearUser();
    if (!name || !(await ui.confirm(`Keep using Linear as ${name}?`))) {
      if (!(await setupKey(ui))) throw new Error('Linear is not connected. Run voidshift again to retry.');
    }

    const teams = await linear().teams();
    let more = Object.keys(config.repos).length === 0 || (await ui.confirm('Add another repo for agents to build in?', false));
    while (more) {
      const cwd = process.cwd();
      const path = expandHome(
        await ui.text('Path to a repo agents should build in', {
          initial: existsSync(join(cwd, '.git')) ? cwd : undefined,
          placeholder: '~/code/my-app',
          validate: (v) => (existsSync(join(expandHome(v.trim()), '.git')) ? undefined : 'Not a git repository'),
        }),
      ).trim();
      const team = await ui.select(
        'Cards from which Linear team build here?',
        teams.map((t) => ({ value: t.key, label: `${t.key}  ${t.name}` })),
      );
      config.repos[team] = resolve(path);
      ctx.log(`${team} cards build in ${resolve(path)}`);
      more = await ui.confirm('Add another repo?', false);
    }
    writeAgentsConfig(ctx.configDir, config);

    if (await ui.confirm('Start the background runner now? It checks Linear every minute for your cards labelled vs-plan.')) {
      const ok = startRunner(ctx.home, [...ctx.selfCommand, 'agents', 'tick'], join(agentsDir(ctx.configDir), 'runner.log'));
      ctx.log(ok ? 'Runner started.' : 'Could not start the runner. Try voidshift agents start.');
    }
    ctx.log('In Claude Code or Codex, connect Linear too, then use /vs-plan, /vs-plan-review and /vs-publish on a card.');
  },

  async uninstall(ctx) {
    stopRunner(ctx.home);
    syncLinks([], candidateHomes(readAgentsConfig(ctx.configDir).homes), ctx.log);
    ctx.log('Agents unlinked and the runner stopped. Config and the Linear key were kept.');
  },

  async checks(ctx): Promise<Check[]> {
    const checks: Check[] = [];
    const homes = readAgentsConfig(ctx.configDir).homes;
    if (!homes.length) checks.push({ name: 'agents installed', status: 'warn', detail: 'in no Claude Code or Codex folder', fix: 'voidshift' });
    for (const h of homes) {
      const missing = packNames().filter((n) => !isOurLink(join(h.dir, 'skills', n)));
      checks.push(
        missing.length === 0
          ? { name: `agents in ${homeLabel(h)}`, status: 'ok', detail: `${packNames().length} linked` }
          : { name: `agents in ${homeLabel(h)}`, status: 'warn', detail: `missing ${missing.join(', ')}`, fix: 'voidshift' },
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
      return (await setupKey(ctx.ui)) ? 0 : 1;
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
