import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, agentsDir, allChains, describeChain, readAgentsConfig, writeAgentsConfig, type AgentsConfig, type StepId } from './config.ts';
import { looksLikeLinearKey, readLinearKey, storeLinearKey } from './keychain.ts';
import { runnerLoaded, startRunner, stopRunner } from './launchd.ts';
import { createLinear } from './linear.ts';
import { findRepos } from './repos.ts';
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

const kindLabel = (k: Home['kind']) => (k === 'claude' ? 'Claude Code' : 'Codex');

// First which agent CLIs, then where each one keeps its config. Codex has one
// home, so it only asks about Claude Code, which people often run from
// several config folders.
async function chooseHomes(ui: Ui, saved: Home[]): Promise<Home[]> {
  const candidates = candidateHomes(saved);
  const kinds = (['claude', 'codex'] as const).filter((k) => candidates.some((h) => h.kind === k));
  const savedKinds = [...new Set(saved.map((h) => h.kind))];
  const picked =
    kinds.length === 1
      ? [...kinds]
      : await ui.multiselect<Home['kind']>(
          'Which do you use?',
          kinds.map((k) => ({ value: k, label: kindLabel(k) })),
          savedKinds.length ? savedKinds : ['claude'],
        );

  const homes: Home[] = [];
  for (const kind of picked) {
    const options = candidates.filter((h) => h.kind === kind);
    if (kind === 'codex') {
      homes.push(...options.slice(0, 1));
      continue;
    }
    const savedDirs = saved.filter((h) => h.kind === kind).map((h) => h.dir);
    const OTHER = '__other__';
    const dirs = await ui.multiselect(
      'Where is your Claude Code config? Pick every folder you use.',
      [...options.map((h) => ({ value: h.dir, label: tilde(h.dir) })), { value: OTHER, label: 'Another folder...' }],
      savedDirs.length ? savedDirs : options.slice(0, 1).map((h) => h.dir),
    );
    homes.push(...options.filter((h) => dirs.includes(h.dir)));
    if (dirs.includes(OTHER)) {
      const dir = await ui.text('Path to the Claude Code config folder (the one with settings.json)', {
        placeholder: '~/work/claude',
        validate: (v) => (existsSync(expandHome(v.trim())) ? undefined : 'That folder does not exist'),
      });
      homes.push({ kind: 'claude', dir: resolve(expandHome(dir.trim())) });
    }
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

// Named local repos the chains run in. Triggers point at them by name.
async function setupProjects(ui: Ui, config: AgentsConfig, log: (l: string) => void): Promise<void> {
  const names = Object.keys(config.projects);
  if (names.length) log(`Projects: ${names.map((n) => `${n} (${tilde(config.projects[n]!.path)})`).join(', ')}`);
  else log('A project is a repo on this Mac where agents do the work. Add one now; triggers point at it.');
  let more = names.length === 0 || (await ui.confirm('Add a project?', false));
  while (more) {
    const isRepo = (v: string) => (existsSync(join(expandHome(v.trim()), '.git')) ? undefined : 'Not a git repository');
    const repos = findRepos([process.cwd()]);
    const TYPE = '__type__';
    const picked = await ui.search(
      'Which repo? Type to search.',
      [
        ...repos.map((r) => ({ value: r, label: r.split('/').pop() ?? r, hint: tilde(r) })),
        { value: TYPE, label: 'Enter a path...', hint: 'not in the list' },
      ],
      'repo name',
    );
    const path = resolve(expandHome(picked === TYPE ? (await ui.path('Repo path', { initial: homedir() + '/', validate: isRepo })).trim() : picked));
    const name = (await ui.text('Name for this project', { initial: path.split('/').pop(), validate: (v) => (v.trim() ? undefined : 'Required') })).trim();
    const url = (await ui.text('URL where the app runs, for the browser check (leave empty to skip)', { placeholder: 'http://localhost:3000' })).trim();
    config.projects[name] = { path, uiUrl: url || undefined };
    log(`Project ${name}: ${tilde(path)}${url ? `, app at ${url}` : ''}`);
    more = await ui.confirm('Add another project?', false);
  }
}

// Chains are agents in order. VoidShift ships some; custom ones are built here.
async function setupChains(ui: Ui, config: AgentsConfig, log: (l: string) => void): Promise<void> {
  for (const [name, chain] of Object.entries(allChains(config))) log(`Chain ${name}: ${describeChain(chain)}`);
  while (await ui.confirm('Build a new chain?', false)) {
    const name = (await ui.text('Name for the chain', { placeholder: 'build-fast', validate: (v) => (v.trim() && !allChains(config)[v.trim()] ? undefined : 'Pick a new name') })).trim();
    const steps: StepId[] = [];
    for (;;) {
      const DONE = '__done__';
      const pick = await ui.select<StepId | typeof DONE>(
        steps.length ? `So far: ${steps.map((s) => STEPS[s].label).join(' → ')}. Add a step:` : 'First step:',
        [
          ...(Object.keys(STEPS) as StepId[]).map((id) => ({ value: id, label: STEPS[id].label, hint: STEPS[id].hint })),
          ...(steps.length ? [{ value: DONE as typeof DONE, label: 'Done' }] : []),
        ],
      );
      if (pick === DONE) break;
      steps.push(pick);
    }
    const work = steps.some((s) => STEPS[s].kind === 'work');
    const rounds = work
      ? Number(await ui.text('If a check fails, how many rounds back to Dev before parking?', { initial: '3', validate: (v) => (/^[1-9]$/.test(v) ? undefined : '1 to 9') }))
      : 1;
    config.chains[name] = { steps, maxRounds: rounds };
    log(`Chain ${name}: ${describeChain(config.chains[name]!)}`);
  }
}

// A trigger: cards in this Linear team with this label run this chain in this project.
async function setupTriggers(ui: Ui, config: AgentsConfig, teams: { key: string; name: string }[], log: (l: string) => void): Promise<void> {
  for (const t of config.triggers) log(`Trigger: ${t.team} + ${t.label} → ${t.chain} in ${t.project}`);
  const projects = Object.keys(config.projects);
  if (!projects.length) return;
  if (!config.triggers.length) log('A trigger starts a chain: your cards in a Linear team that carry a label.');
  let more = config.triggers.length === 0 || (await ui.confirm('Add a trigger?', false));
  while (more) {
    const team = await ui.select('Linear team', teams.map((t) => ({ value: t.key, label: `${t.key}  ${t.name}` })));
    const label = (await ui.text('Label that starts it', { initial: 'vs-plan', validate: (v) => (v.trim() ? undefined : 'Required') })).trim();
    const chains = allChains(config);
    const chain = await ui.select('Chain to run', Object.keys(chains).map((n) => ({ value: n, label: n, hint: describeChain(chains[n]!) })), 'build');
    const project = projects.length === 1 ? projects[0]! : await ui.select('In which project?', projects.map((n) => ({ value: n, label: n, hint: tilde(config.projects[n]!.path) })));
    config.triggers = config.triggers.filter((t) => !(t.team === team && t.label === label));
    config.triggers.push({ source: 'linear', team, label, chain, project });
    log(`Trigger: ${team} + ${label} → ${chain} in ${project}`);
    more = await ui.confirm('Add another trigger?', false);
  }
}

const usage = `voidshift agents <command>
  status                     Triggers, chains, projects and the runner
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

    await setupProjects(ui, config, ctx.log);
    await setupChains(ui, config, ctx.log);
    await setupTriggers(ui, config, await linear().teams(), ctx.log);
    writeAgentsConfig(ctx.configDir, config);

    if (config.triggers.length && (await ui.confirm('Start the background runner now? It checks Linear every minute for cards matching your triggers.'))) {
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
    const chains = allChains(config);
    const broken = config.triggers.filter((t) => !chains[t.chain] || !config.projects[t.project] || !existsSync(join(config.projects[t.project]!.path, '.git')));
    checks.push(
      !config.triggers.length
        ? { name: 'agent triggers', status: 'warn', detail: 'none yet', fix: 'voidshift' }
        : broken.length
          ? { name: 'agent triggers', status: 'fail', detail: `${broken.map((t) => `${t.team}+${t.label}`).join(', ')} point at a missing chain or project`, fix: 'voidshift' }
          : { name: 'agent triggers', status: 'ok', detail: `${config.triggers.length} active` },
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
      ctx.log(`Engine: ${c.engine}`);
      for (const [n, p] of Object.entries(c.projects)) ctx.log(`Project ${n}: ${tilde(p.path)}${p.uiUrl ? `, app at ${p.uiUrl}` : ''}`);
      for (const [n, ch] of Object.entries(allChains(c))) ctx.log(`Chain ${n}: ${describeChain(ch)}`);
      for (const t of c.triggers) ctx.log(`Trigger: ${t.team} + ${t.label} → ${t.chain} in ${t.project}`);
      if (!c.triggers.length) ctx.log('No triggers yet. Run voidshift to add one.');
      ctx.log(`Runner: ${runnerLoaded() ? 'running' : 'stopped'}${existsSync(join(agentsDir(ctx.configDir), 'runner.lock')) ? ', working on a card now' : ''}`);
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
      if (!readAgentsConfig(ctx.configDir).triggers.length) {
        ctx.log('Add a trigger first: run voidshift.');
        return 1;
      }
      const ok = startRunner(ctx.home, [...ctx.selfCommand, 'agents', 'tick'], join(agentsDir(ctx.configDir), 'runner.log'));
      ctx.log(ok ? 'Runner started. It checks Linear every minute for cards matching your triggers.' : 'Could not start the runner.');
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

export default agents;
