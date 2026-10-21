import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, STEPS, TEMPLATES, isProducer, agentsDir, describeWorkflow, describeSteps, stepEnabled, visibleAgents, readAgentsConfig, writeAgentsConfig, type AgentsConfig, type StepId, type Trigger } from './config.ts';
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
function syncLinks(chosen: Home[], all: Home[], enabled: string[], log: (l: string) => void): void {
  for (const home of all) {
    const skills = join(home.dir, 'skills');
    const wanted = chosen.some((h) => h.dir === home.dir);
    let existing: string[] = [];
    try {
      existing = readdirSync(skills);
    } catch {
      // no skills folder yet
    }
    for (const name of existing) {
      const stale = !packNames().includes(name) || !wanted || !enabled.includes(name);
      if (stale && isOurLink(join(skills, name))) rmSync(join(skills, name));
    }
    if (!wanted) continue;
    mkdirSync(skills, { recursive: true });
    for (const name of packNames().filter((n) => enabled.includes(n))) {
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

// Named local repos the workflows run in. Triggers point at them by name.
async function setupProjects(ui: Ui, config: AgentsConfig, log: (l: string) => void): Promise<void> {
  const names = Object.keys(config.projects);
  if (names.length) log(`Projects: ${names.map((n) => `${n} (${tilde(config.projects[n]!.path)})`).join(', ')}`);
  else log('A project is a repo on this Mac where agents do the work. Add one now; workflows run in it.');
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
    config.projects[name] = { ...config.projects[name], path };
    log(`Project ${name}: ${tilde(path)}`);
    more = await ui.confirm('Add another project?', false);
  }
}

const CUSTOM = '__custom__';

// Pick steps one at a time from the enabled agents.
async function pickSteps(ui: Ui, config: AgentsConfig): Promise<StepId[]> {
  const steps: StepId[] = [];
  for (;;) {
    const DONE = '__done__';
    const pick = await ui.select<StepId | typeof DONE>(
      steps.length ? `So far: ${describeSteps(steps)}. Add a step:` : 'First step:',
      [
        ...(Object.keys(STEPS) as StepId[])
          .filter((id) => stepEnabled(id, config.enabled))
          .map((id) => ({ value: id, label: STEPS[id].label, hint: STEPS[id].hint })),
        ...(steps.length ? [{ value: DONE as typeof DONE, label: 'Done' }] : []),
      ],
    );
    if (pick === DONE) return steps;
    steps.push(pick);
  }
}

// A workflow: what starts it, the steps it runs, and the project it runs in.
async function setupWorkflows(ui: Ui, config: AgentsConfig, teams: { key: string; name: string }[], log: (l: string) => void): Promise<void> {
  log(
    [
      'A workflow starts when one of your Linear cards gets a label, then runs agents',
      'in order in a project. When a check (Plan review or QA) finds problems, the',
      'work goes back to the step that made it, Plan or Dev, with the findings, until',
      'the checks pass or the limit parks the card for you.',
    ].join('\n'),
  );
  for (const [name, workflow] of Object.entries(config.workflows)) log(`Workflow ${name}: ${describeWorkflow(workflow)}`);
  const projects = Object.keys(config.projects);
  if (!projects.length) return;

  let more = Object.keys(config.workflows).length === 0 || (await ui.confirm('Create another workflow?', false));
  while (more) {
    const triggers: Trigger[] = [];
    do {
      const team = await ui.select(
        triggers.length ? 'Also start for cards in which Linear team?' : 'Starts when a card in which Linear team...',
        teams.map((t) => ({ value: t.key, label: `${t.key}  ${t.name}` })),
      );
      const label = (await ui.text('...gets which label?', { initial: 'vs-plan', validate: (v) => (v.trim() ? undefined : 'Required') })).trim();
      triggers.push({ source: 'linear', team, label });
    } while (await ui.confirm('Add another way to start this workflow?', false));

    const usable = Object.entries(TEMPLATES).filter(([, t]) => t.steps.every((st) => stepEnabled(st, config.enabled)));
    const template = await ui.select(
      'Which steps?',
      [
        ...usable.map(([n, t]) => ({ value: n, label: n, hint: describeSteps(t.steps) })),
        { value: CUSTOM, label: 'Pick my own steps' },
      ],
      usable.some(([n]) => n === 'build') ? 'build' : undefined,
    );
    const steps = template === CUSTOM ? await pickSteps(ui, config) : TEMPLATES[template]!.steps;
    const maxRounds =
      template !== CUSTOM
        ? TEMPLATES[template]!.maxRounds
        : steps.some(isProducer)
          ? Number(await ui.text('If a check fails, how many times can it send the work back before parking?', { initial: '3', validate: (v) => (/^[1-9]$/.test(v) ? undefined : '1 to 9') }))
          : 1;
    const project = projects.length === 1 ? projects[0]! : await ui.select('Runs in which project?', projects.map((n) => ({ value: n, label: n, hint: tilde(config.projects[n]!.path) })));
    const suggested = `${project}-${template === CUSTOM ? 'custom' : template}`;
    const name = (await ui.text('Name for this workflow', { initial: config.workflows[suggested] ? undefined : suggested, validate: (v) => (v.trim() && !config.workflows[v.trim()] ? undefined : 'Pick a new name') })).trim();

    config.workflows[name] = { triggers, steps, maxRounds, project };
    log(`Workflow ${name}: ${describeWorkflow(config.workflows[name]!)}`);
    more = await ui.confirm('Create another workflow?', false);
  }
}

const usage = `voidshift agents <command>
  status                     Workflows, projects and the runner
  key                        Store or replace the Linear API key
  run [CARD]                 Run the workflow once now, in this terminal
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
    const enabled = await ui.multiselect(
      'Which agents do you want?',
      visibleAgents().map((a) => ({ value: a, label: AGENTS[a]!.label, hint: AGENTS[a]!.hint })),
      config.enabled.length ? config.enabled.filter((a) => visibleAgents().includes(a)) : visibleAgents(),
    );
    if (!enabled.length) throw new Error('pick at least one agent');
    syncLinks(homes, candidateHomes([...config.homes, ...homes]), enabled, ctx.log);
    config.homes = homes;
    config.enabled = enabled;

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
    await setupWorkflows(ui, config, await linear().teams(), ctx.log);
    writeAgentsConfig(ctx.configDir, config);

    if (Object.keys(config.workflows).length && (await ui.confirm('Start the background runner now? It checks Linear every minute for cards that start your workflows.'))) {
      const ok = startRunner(ctx.home, [...ctx.selfCommand, 'agents', 'tick'], join(agentsDir(ctx.configDir), 'runner.log'));
      ctx.log(ok ? 'Runner started.' : 'Could not start the runner. Try voidshift agents start.');
    }
    ctx.log('In Claude Code or Codex, connect Linear too, then use /vs-plan, /vs-plan-review and /vs-publish on a card.');
  },

  async uninstall(ctx) {
    stopRunner(ctx.home);
    syncLinks([], candidateHomes(readAgentsConfig(ctx.configDir).homes), [], ctx.log);
    ctx.log('Agents unlinked and the runner stopped. Config and the Linear key were kept.');
  },

  async checks(ctx): Promise<Check[]> {
    const checks: Check[] = [];
    const saved = readAgentsConfig(ctx.configDir);
    const homes = saved.homes;
    const wanted = packNames().filter((n) => !saved.enabled.length || saved.enabled.includes(n));
    if (!homes.length) checks.push({ name: 'agents installed', status: 'warn', detail: 'in no Claude Code or Codex folder', fix: 'voidshift' });
    for (const h of homes) {
      const missing = wanted.filter((n) => !isOurLink(join(h.dir, 'skills', n)));
      checks.push(
        missing.length === 0
          ? { name: `agents in ${homeLabel(h)}`, status: 'ok', detail: `${wanted.length} linked` }
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
    const workflows = Object.entries(config.workflows);
    const broken = workflows.filter(([, c]) => !config.projects[c.project] || !existsSync(join(config.projects[c.project]!.path, '.git'))).map(([n]) => n);
    checks.push(
      !workflows.length
        ? { name: 'agent workflows', status: 'warn', detail: 'none yet', fix: 'voidshift' }
        : broken.length
          ? { name: 'agent workflows', status: 'fail', detail: `${broken.join(', ')} point at a missing project`, fix: 'voidshift' }
          : { name: 'agent workflows', status: 'ok', detail: `${workflows.length} ready` },
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
      for (const [n, ch] of Object.entries(c.workflows)) ctx.log(`Workflow ${n}: ${describeWorkflow(ch)}`);
      if (!Object.keys(c.workflows).length) ctx.log('No workflows yet. Run voidshift to create one.');
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
      if (!Object.keys(readAgentsConfig(ctx.configDir).workflows).length) {
        ctx.log('Create a workflow first: run voidshift.');
        return 1;
      }
      const ok = startRunner(ctx.home, [...ctx.selfCommand, 'agents', 'tick'], join(agentsDir(ctx.configDir), 'runner.log'));
      ctx.log(ok ? 'Runner started. It checks Linear every minute for cards that start your workflows.' : 'Could not start the runner.');
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
