import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AGENTS, AGENT_FILE, STEPS, TEMPLATES, isProducer, agentFolders, agentsDir, describeSteps, describeTrigger, describeTriggers, describeWorkflow, stepEnabled, stepId, visibleAgents, readAgentsConfig, writeAgentsConfig, DEFAULTS, type AgentsConfig, type Project, type Step, type StepId, type Trigger, type Workflow } from './config.ts';
import { controlChecks, controlCommands, controlUsage } from './control.ts';
import { keyStore, looksLikeLinearKey, readLinearKey, readSecret, storeLinearKey, storeSecret } from './secrets.ts';
import { TRACKERS } from './tracker.ts';
import { createVoidTrack } from './voidtrack.ts';
import { parseCron } from './cron.ts';
import { trackersInUse } from './control.ts';
import { runnerService } from './service.ts';
import { initProfile, profileChecks, profileDir, readRules, renderClaudeSettings, CLAUDE_SETTINGS, RULES_FILE } from './profile.ts';
import { createLinear } from './linear.ts';
import { TRIGGER_FORMS, duplicateTriggerWarnings, moveKey, parseTrigger, renameKey, sameTrigger, validateAgentFolder, validateConfig, validateWorkflow, workflowsUsing, type Place } from './manage.ts';
import { parseStep, resolveName, stepNames } from './names.ts';
import { findRepos } from './repos.ts';
import { defaultBranch, sh } from './git.ts';
import type { Check, Tool, ToolContext, Ui } from './types.ts';

const packDir = fileURLToPath(new URL('../pack/', import.meta.url));
const packNames = () => readdirSync(packDir).filter((n) => existsSync(join(packDir, n, 'SKILL.md')));

type Home = { kind: 'claude' | 'codex'; dir: string };

const has = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const tilde = (p: string) => p.replace(homedir(), '~');
const homeLabel = (h: Home) => `${h.kind === 'claude' ? 'Claude Code' : 'Codex'}  ${tilde(h.dir)}`;
const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const isRepo = (dir: string) => existsSync(join(dir, '.git'));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Claude Code folders the memory tool saved, so one picked there is found here.
function memoryHomes(configDir: string): Home[] {
  try {
    const saved = JSON.parse(readFileSync(join(configDir, 'memory', 'config.json'), 'utf8')).homes;
    return (Array.isArray(saved) ? saved : []).filter((h) => h?.kind === 'claude' && typeof h.dir === 'string').map((h) => ({ kind: 'claude' as const, dir: resolve(h.dir) }));
  } catch {
    return [];
  }
}

// Config folders that could hold the agents: Claude Code reads
// CLAUDE_CONFIG_DIR or ~/.claude, Codex reads CODEX_HOME or ~/.codex, plus any
// folder chosen before here or in the memory tool.
function candidateHomes(configDir: string, saved: Home[]): Home[] {
  const found: Home[] = [];
  if (has('claude')) {
    for (const d of [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]) if (d) found.push({ kind: 'claude', dir: resolve(d) });
  }
  if (has('codex')) found.push({ kind: 'codex', dir: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')) });
  // Memory-tool homes only count while the folder exists and Claude Code is still installed.
  const fromMemory = has('claude') ? memoryHomes(configDir).filter((h) => existsSync(h.dir)) : [];
  const all = [...saved, ...found, ...fromMemory];
  return all.filter((h, i) => all.findIndex((o) => o.dir === h.dir) === i);
}

const kindLabel = (k: Home['kind']) => (k === 'claude' ? 'Claude Code' : 'Codex');

// First which agent CLIs, then where each one keeps its config. Codex has one
// home, so it only asks about Claude Code, which people often run from
// several config folders.
async function chooseHomes(ui: Ui, configDir: string, saved: Home[]): Promise<Home[]> {
  const candidates = candidateHomes(configDir, saved);
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

// Checks the key against Linear, and only then stores it.
async function verifyAndStore(configDir: string, key: string, info: (l: string) => void, warn: (l: string) => void, kind: 'linear' | 'voidtrack' = 'linear'): Promise<string | null> {
  const name = TRACKERS[kind].name;
  try {
    const me = await (kind === 'voidtrack' ? createVoidTrack(key) : createLinear(key)).viewer();
    if (!(kind === 'voidtrack' ? storeSecret(configDir, 'voidtrack', key) : storeLinearKey(configDir, key))) {
      warn(`${name} accepted the key but it could not be stored in ${keyStore()}.`);
      return null;
    }
    info(`${name} connected as ${me.name}. Key stored in ${keyStore()}.`);
    return me.name;
  } catch (err) {
    warn(`${name} did not accept that key: ${(err as Error).message}. Nothing was stored.`);
    return null;
  }
}

// Asks for the key, checks it against Linear, and only then stores it.
async function setupKey(ui: Ui, configDir: string, kind: 'linear' | 'voidtrack' = 'linear'): Promise<string | null> {
  const { name, keyHint } = TRACKERS[kind];
  ui.info(`Agents need a ${name} API key (${keyHint}).`);
  const key = await ui.secret(`Paste your ${name} API key`, (v) =>
    kind === 'linear' ? (looksLikeLinearKey(v.trim()) ? undefined : 'Linear keys start with lin_api_') : v.trim() ? undefined : 'Required',
  );
  return verifyAndStore(configDir, key.trim(), ui.info, ui.warn, kind);
}

async function currentLinearUser(configDir: string): Promise<string | null> {
  try {
    return readLinearKey(configDir) ? (await linear(configDir).viewer()).name : null;
  } catch {
    return null;
  }
}

// Ours: points into this install's pack, or into an agents/pack/vs-* folder
// (the pack of another install or of a source checkout).
const isOurLink = (path: string) => {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = resolve(dirname(path), readlinkSync(path));
    const pack = resolve(packDir);
    return target === pack || target.startsWith(pack + sep) || /[\\/]agents[\\/]pack[\\/]vs-[a-z-]+[\\/]?$/.test(target);
  } catch {
    return false;
  }
};

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
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
    let linked = 0;
    let skipped = 0;
    for (const name of packNames().filter((n) => enabled.includes(n))) {
      const dest = join(skills, name);
      const want = join(packDir, name);
      if (isOurLink(dest)) {
        // Ours but from somewhere else, or broken: point it at this install.
        if (resolve(dirname(dest), readlinkSync(dest)) !== resolve(want)) {
          rmSync(dest);
          symlinkSync(want, dest);
        }
        linked++;
      } else if (exists(dest)) {
        skipped++;
        log(`Skipped ${name} in ${tilde(home.dir)}: something else is already there`);
      } else {
        symlinkSync(want, dest);
        linked++;
      }
    }
    if (!linked && skipped) log(`Agents NOT linked in ${homeLabel(home)}: every name is taken by something else.`);
    else log(`Agents linked in ${homeLabel(home)}: ${linked} linked${skipped ? `, ${skipped} skipped (something else is already there)` : ''}`);
  }
}

function linear(configDir: string) {
  const key = readLinearKey(configDir);
  if (!key) throw new Error('No Linear API key. Run vsf agents key');
  return createLinear(key);
}

// One project: its repo and the branch pull requests go into. Fields already
// in `current` are not asked again, unless editing, where they are the defaults.
async function promptProject(ui: Ui, config: AgentsConfig, current: { name?: string; path?: string; base?: string } = {}, edit = false, allowExisting = false): Promise<{ name: string; project: Project }> {
  const check = (v: string) => (isRepo(expandHome(v.trim())) ? undefined : 'Not a git repository');
  let path = current.path;
  if (!path || edit) {
    if (edit) path = resolve(expandHome((await ui.path('Repo path', { initial: current.path, validate: check })).trim()));
    else {
      const repos = findRepos([process.cwd()]);
      const TYPE = '__type__';
      const picked = await ui.search(
        'Which repo? Type to search.',
        [
          ...repos.map((r) => ({ value: r, label: r.split('/').pop() ?? r, hint: tilde(r) })),
          { value: TYPE, label: 'Enter a path...', hint: 'not in the list' },
        ],
        'repo name',
        repos.includes(resolve(process.cwd())) ? resolve(process.cwd()) : undefined,
      );
      path = resolve(expandHome(picked === TYPE ? (await ui.path('Repo path', { initial: homedir() + '/', validate: check })).trim() : picked));
    }
  }
  const name = current.name ?? (await ui.text('Name for this project', { initial: basename(path), validate: (v) => (!v.trim() ? 'Required' : !allowExisting && config.projects[v.trim()] ? 'Pick a new name' : undefined) })).trim();
  let base = current.base;
  if (base === undefined || edit) {
    const remote = sh('git', ['branch', '-r', '--format=%(refname:short)'], path).stdout.split('\n')
      .map((b) => b.trim().replace(/^origin\//, '')).filter((b) => b && b !== 'HEAD' && !b.includes(' ') && b !== 'origin');
    let fallback = '';
    try {
      fallback = defaultBranch(path);
    } catch {
      // no origin HEAD; the list still works
    }
    const start = base || fallback;
    base = remote.length
      ? await ui.search('Pull requests go into which branch?', remote.map((b) => ({ value: b, label: b, hint: b === fallback ? 'default' : undefined })), 'branch', start || undefined)
      : start;
  }
  const project: Project = { ...config.projects[name], path };
  if (base) project.base = base;
  else delete project.base;
  return { name, project };
}

const describeProject = (config: AgentsConfig, name: string) => {
  const p = config.projects[name]!;
  const used = workflowsUsing(config, name);
  return `${name}  ${tilde(p.path)}, PRs into ${p.base ?? 'the default branch'}, ${used.length ? `used by ${used.join(', ')}` : 'not used by any workflow'}`;
};

// Named local repos the workflows run in. Triggers point at them by name.
async function setupProjects(ui: Ui, config: AgentsConfig, log: (l: string) => void): Promise<void> {
  const names = Object.keys(config.projects);
  if (names.length) log(`Projects: ${names.map((n) => `${n} (${tilde(config.projects[n]!.path)})`).join(', ')}`);
  else log('A project is a repo on this Mac where agents do the work. Add one now; workflows run in it.');
  let more = names.length === 0 || (await ui.confirm('Add a project?', false));
  while (more) {
    const { name, project } = await promptProject(ui, config, {}, false, true);
    config.projects[name] = project;
    log(`Project ${name}: ${tilde(project.path)}${project.base ? `, PRs into ${project.base}` : ''}`);
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

type Team = { key: string; name: string; mine: boolean };

// One workflow: what starts it, its steps, its project and its name. Fields
// already in `current` are not asked again, unless editing, where each one
// is offered as the default.
async function promptWorkflow(
  ui: Ui,
  config: AgentsConfig,
  teams: Team[],
  current: { name?: string; workflow?: Partial<Workflow> } = {},
  edit = false,
): Promise<{ name: string; workflow: Workflow }> {
  const w = current.workflow ?? {};
  const keep = async (what: string, shown: string) => !edit || (await ui.confirm(`Keep ${what} (${shown})?`, true));
  const myTeams = teams.filter((t) => t.mine);

  let triggers = w.triggers?.length && (await keep('triggers', describeTriggers(w.triggers))) ? w.triggers : undefined;
  if (!triggers) {
    triggers = [];
    do {
      const source = await ui.select<'linear' | 'voidtrack' | 'cron'>(
        triggers.length ? 'Also start it when...' : 'Starts when...',
        [
          { value: 'linear', label: 'A Linear card gets a label' },
          { value: 'voidtrack', label: 'A VoidTrack card gets a label' },
          { value: 'cron', label: 'On a schedule', hint: 'runs on a standing task, no card' },
        ],
        'linear',
      );
      if (source === 'cron') {
        const schedule = (await ui.text('Cron schedule (minute hour day month weekday)', { initial: '0 5 * * 1', validate: (v) => (parseCron(v) ? undefined : 'Five fields, like 0 5 * * 1') })).trim();
        const task = (await ui.text('What should each run work on?', { placeholder: 'Update the dependencies and fix what breaks', validate: (v) => (v.trim() ? undefined : 'Required') })).trim();
        triggers.push({ source: 'cron', schedule, task });
        continue;
      }
      const team =
        source === 'linear' && teams.length
          ? await ui.select(
              'A card in which Linear team...',
              teams.map((t) => ({ value: t.key, label: `${t.key}  ${t.name}`, hint: t.mine ? 'your team' : undefined })),
              myTeams.length === 1 ? myTeams[0]!.key : undefined,
            )
          : (await ui.text(`A card in which ${TRACKERS[source].name} team key...`, { validate: (v) => (v.trim() ? undefined : 'Required') })).trim().toUpperCase();
      const label = (await ui.text('...gets which label?', { initial: 'vs-plan', validate: (v) => (v.trim() ? undefined : 'Required') })).trim();
      triggers.push({ source, team, label });
    } while (await ui.confirm('Add another way to start this workflow?', false));
  }

  let steps: Step[] | undefined = w.steps?.length && (await keep('steps', describeSteps(w.steps))) ? w.steps : undefined;
  let template: string | undefined;
  if (!steps) {
    const usable = Object.entries(TEMPLATES).filter(([, t]) => t.steps.every((st) => stepEnabled(st, config.enabled)));
    template = await ui.select(
      'Which steps?',
      [
        ...usable.map(([n, t]) => ({ value: n, label: n, hint: describeSteps(t.steps) })),
        { value: CUSTOM, label: 'Pick my own steps' },
      ],
      usable.some(([n]) => n === 'build') ? 'build' : undefined,
    );
    steps = template === CUSTOM ? await pickSteps(ui, config) : TEMPLATES[template]!.steps;
  }

  let maxRounds = w.maxRounds;
  if (maxRounds === undefined || edit) {
    if (template && template !== CUSTOM && maxRounds === undefined) maxRounds = TEMPLATES[template]!.maxRounds;
    else if (steps.some(isProducer)) {
      maxRounds = Number(await ui.text('If a check fails, how many times can it send the work back before parking?', { initial: String(maxRounds ?? 3), validate: (v) => (/^[1-9]$/.test(v) ? undefined : '1 to 9') }));
    } else maxRounds = 1;
  }

  const projects = Object.keys(config.projects);
  const project =
    w.project && (await keep('project', w.project))
      ? w.project
      : projects.length === 1
        ? projects[0]!
        : await ui.select('Runs in which project?', projects.map((n) => ({ value: n, label: n, hint: tilde(config.projects[n]!.path) })), w.project);

  let name = current.name;
  if (name === undefined || edit) {
    const suggested = `${project}-${template && template !== CUSTOM ? template : 'custom'}`;
    const start = name ?? (config.workflows[suggested] ? undefined : suggested);
    name = (await ui.text('Name for this workflow', { initial: start, validate: (v) => (v.trim() && (v.trim() === current.name || !config.workflows[v.trim()]) ? undefined : 'Pick a new name') })).trim();
  }
  return { name, workflow: { triggers, steps, maxRounds, project } };
}

// A workflow starts on its triggers, runs its steps in order, in its project.
async function setupWorkflows(ui: Ui, config: AgentsConfig, teams: Team[], log: (l: string) => void): Promise<void> {
  log(
    [
      'A workflow starts when one of your Linear cards gets a label, then runs agents',
      'in order in a project. When a check (Plan review or QA) finds problems, the',
      'work goes back to the step that made it, Plan or Dev, with the findings, until',
      'the checks pass or the limit parks the card for you.',
    ].join('\n'),
  );
  for (const [name, workflow] of Object.entries(config.workflows)) log(`Workflow ${name}: ${describeWorkflow(workflow)}`);
  if (!Object.keys(config.projects).length) return;

  let more = Object.keys(config.workflows).length === 0 || (await ui.confirm('Create another workflow?', false));
  while (more) {
    const { name, workflow } = await promptWorkflow(ui, config, teams);
    config.workflows[name] = workflow;
    log(`Workflow ${name}: ${describeWorkflow(workflow)}`);
    more = await ui.confirm('Create another workflow?', false);
  }
}
// One entry per command, in the order help lists them.
const USAGE: [string, string][] = [
  ['workflows [--json]', 'List workflows in the order they match'],
  ['workflow add [NAME] [--trigger TEAM:LABEL]... [--steps dev,qa | --template build] [--project P] [--rounds N]', 'Create a workflow; prompts for what is missing. A trigger is TEAM:LABEL (Linear), voidtrack:TEAM:LABEL or "cron:SCHEDULE:TASK"'],
  ['workflow show NAME [--json]', 'Show one workflow'],
  ['workflow edit NAME [--trigger T:L]... [--add-trigger T:L] [--remove-trigger T:L] [--steps S | --template T] [--project P] [--rounds N]', 'Change a workflow; no flags asks'],
  ['workflow rename OLD NEW', 'Rename a workflow, keeping its place'],
  ['workflow rm NAME [--yes]', 'Delete a workflow'],
  ['workflow move NAME (--first | --last | --before OTHER | --after OTHER)', 'Change the match order'],
  ['projects [--json]', 'List projects'],
  ['project add [NAME] [--path P] [--base B]', 'Add a project; prompts for what is missing'],
  ['project show NAME [--json]', 'Show one project'],
  ['project edit NAME [--path P] [--base B]', 'Change a project; no flags asks'],
  ['project rename OLD NEW', 'Rename a project and the workflows that use it'],
  ['project rm NAME [--yes]', 'Delete a project nothing uses'],
  ['homes [--json]', 'Show where the agents are linked'],
  ['link DIR [--claude | --codex]', 'Link the agents into a config folder'],
  ['unlink DIR', 'Remove the agents from a config folder'],
  ['key [--voidtrack]', 'Store or replace the Linear or VoidTrack API key (reads stdin without a terminal)'],
  ['profile [init]', `Your profile: rules (${RULES_FILE}) and Claude settings (${CLAUDE_SETTINGS}) every agent run carries; init creates it`],
  ['validate [DIR]', `Check an agent folder (DIR/${AGENT_FILE} and its prompts), or the config and every folder under agents/defs`],
  ['help [COMMAND]', 'Show this list, or one command'],
];

const usageOf = (name: string) =>
  USAGE.filter(([c]) => c === name || c.startsWith(`${name} `))
    .map(([c, d]) => `vsf agents ${c}\n  ${d}`)
    .join('\n');

// Control lines are "signature   description"; both lists print the same way.
const fullUsage = () => {
  const control = Object.values(controlUsage).map((l) => l.split(/\s{3,}/) as [string, string]);
  return ['vsf agents <command>', '', ...[...control, ...USAGE].map(([c, d]) => `  ${c}\n      ${d}`)].join('\n');
};

type Parsed = { values: Record<string, any>; positionals: string[] };

// Parses flags; a bad one prints one plain line plus the usage.
function parse(args: string[], options: Record<string, { type: 'boolean' | 'string'; short?: string; multiple?: boolean }>, usage: string, ctx: ToolContext): Parsed | null {
  try {
    const r = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, any>, positionals: r.positionals };
  } catch (err) {
    ctx.log((err as Error).message.split(/\.\s/)[0]!.replace(/\.$/, '') + '.');
    ctx.log(usage);
    return null;
  }
}

const out = (ctx: ToolContext, value: unknown) => ctx.log(JSON.stringify(value, null, 2));
const interactive = () => !!process.stdin.isTTY;

// Sets up a command: handles --help and bad flags. Returns the parsed args,
// or the exit code to return.
function begin(key: string, args: string[], options: Record<string, { type: 'boolean' | 'string'; short?: string; multiple?: boolean }>, ctx: ToolContext): Parsed | number {
  const usage = usageOf(key);
  const p = parse(args, options, usage, ctx);
  if (!p) return 2;
  if (p.values.help) {
    ctx.log(usage);
    return 0;
  }
  return p;
}

const needArgs = (p: Parsed, n: number, key: string, ctx: ToolContext) => {
  if (p.positionals.length === n) return true;
  ctx.log(`Expected ${plural(n, 'name')}.`);
  ctx.log(usageOf(key));
  return false;
};

// Runs a subcommand group: workflow add, project rm, ...
async function group(name: string, subs: Record<string, ToolCommand>, args: string[], ctx: ToolContext): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === '--help' || sub === '-h') {
    ctx.log(usageOf(name));
    return 0;
  }
  if (!sub || !Object.hasOwn(subs, sub)) {
    ctx.log(sub ? `Unknown ${name} command ${sub}.` : `Say what to do with a ${name}.`);
    ctx.log(usageOf(name));
    return 2;
  }
  return subs[sub]!(rest, ctx);
}

type ToolCommand = (args: string[], ctx: ToolContext) => Promise<number>;

const save = (ctx: ToolContext, config: AgentsConfig) => writeAgentsConfig(ctx.configDir, config);

// Refuses a rm without --yes when there is nobody to ask.
async function confirmed(question: string, yes: boolean, ctx: ToolContext): Promise<boolean | 'refused'> {
  if (yes) return true;
  if (!interactive()) {
    ctx.log('Not asking without a terminal. Add --yes to go ahead.');
    return 'refused';
  }
  return ctx.ui.confirm(question, false);
}

// ---- workflows ----

const roundsText = (w: Workflow) => plural(w.maxRounds, 'round');

function listWorkflows(config: AgentsConfig, ctx: ToolContext): void {
  Object.entries(config.workflows).forEach(([n, w], i) => ctx.log(`${i + 1}. ${n}  ${describeWorkflow(w)}, ${roundsText(w)}`));
  ctx.log('The first workflow that matches a card wins. vsf agents workflow move changes the order.');
}

type WorkflowFlags = { triggers?: Trigger[]; steps?: StepId[]; maxRounds?: number; project?: string; fromTemplate?: boolean };

// The workflow flags shared by add and edit. A string is a complaint to print
// (code 2 for bad input, 1 for a name that does not resolve).
function readWorkflowFlags(v: Record<string, any>, config: AgentsConfig): WorkflowFlags | { error: string; code: number } {
  const flags: WorkflowFlags = {};
  if (v.trigger?.length) {
    flags.triggers = [];
    for (const t of v.trigger as string[]) {
      const parsed = parseTrigger(t);
      if (!parsed) return { error: `Bad trigger ${t}. Use ${TRIGGER_FORMS}.`, code: 2 };
      flags.triggers.push(parsed);
    }
  }
  if (v.steps !== undefined && v.template !== undefined) return { error: 'Use either --steps or --template, not both.', code: 2 };
  if (v.steps !== undefined) {
    flags.steps = [];
    for (const s of String(v.steps).split(',').map((x) => x.trim()).filter(Boolean)) {
      const id = parseStep(s);
      if (!id) return { error: `Unknown step ${s}. Steps: ${stepNames()}.`, code: 2 };
      flags.steps.push(id);
    }
    if (!flags.steps.length) return { error: `--steps needs at least one step. Steps: ${stepNames()}.`, code: 2 };
  }
  if (v.template !== undefined) {
    const t = TEMPLATES[v.template];
    if (!t) return { error: `Unknown template ${v.template}. Templates: ${Object.keys(TEMPLATES).join(', ')}.`, code: 2 };
    flags.steps = [...t.steps];
    flags.maxRounds = t.maxRounds;
    flags.fromTemplate = true;
  }
  if (v.rounds !== undefined) {
    if (!/^[1-9]$/.test(v.rounds)) return { error: 'Rounds must be a whole number from 1 to 9.', code: 2 };
    flags.maxRounds = Number(v.rounds);
  }
  if (v.project !== undefined) {
    const r = resolveName(Object.keys(config.projects), v.project, 'project');
    if ('error' in r) return { error: r.error, code: 1 };
    flags.project = r.name;
  }
  return flags;
}

function pickWorkflow(config: AgentsConfig, input: string, ctx: ToolContext): string | null {
  const r = resolveName(Object.keys(config.workflows), input, 'workflow');
  if ('error' in r) {
    ctx.log(r.error);
    return null;
  }
  return r.name;
}

// A workflow from an agent folder is changed by editing its file. True (and
// says so) when `name` is one.
function inFolder(config: AgentsConfig, name: string, ctx: ToolContext): boolean {
  const dir = config.folders?.[name];
  if (dir) ctx.log(`${name} is defined in ${tilde(join(dir, AGENT_FILE))}; edit that file.`);
  return !!dir;
}

async function teamsOrNull(ctx: ToolContext): Promise<Team[] | null> {
  try {
    return await linear(ctx.configDir).teams();
  } catch (err) {
    ctx.log(`Could not list Linear teams: ${(err as Error).message}`);
    return null;
  }
}

// Validates, then saves. Prints one line and returns 1 when it is not valid.
function saveWorkflow(config: AgentsConfig, name: string, workflow: Workflow, ctx: ToolContext, verb = ''): number {
  const problems = validateWorkflow(config, workflow);
  if (problems.length) {
    ctx.log(`Workflow ${name} is not valid: ${problems.join(' ')}`);
    return 1;
  }
  save(ctx, config);
  ctx.log(`Workflow ${verb}${name}: ${describeWorkflow(workflow)}`);
  for (const line of duplicateTriggerWarnings(config.workflows, name, workflow)) ctx.log(line);
  return 0;
}

const workflowSubs: Record<string, ToolCommand> = {
  async add(args, ctx) {
    const options = { trigger: { type: 'string', multiple: true }, steps: { type: 'string' }, template: { type: 'string' }, project: { type: 'string' }, rounds: { type: 'string' } } as const;
    const p = begin('workflow add', args, options, ctx);
    if (typeof p === 'number') return p;
    const config = readAgentsConfig(ctx.configDir);
    if (!Object.keys(config.projects).length) {
      ctx.log('No projects yet. vsf agents project add creates one.');
      return 1;
    }
    const flags = readWorkflowFlags(p.values, config);
    if ('error' in flags) {
      ctx.log(flags.error);
      return flags.code;
    }
    if (p.positionals.length > 1) {
      ctx.log('Give at most one name.');
      ctx.log(usageOf('workflow add'));
      return 2;
    }
    const projects = Object.keys(config.projects);
    flags.project ??= projects.length === 1 ? projects[0] : undefined;
    // Steps from flags carry their usual rounds unless --rounds said otherwise.
    if (flags.steps && flags.maxRounds === undefined) flags.maxRounds = flags.steps.some(isProducer) ? 3 : 1;
    let name = p.positionals[0]?.trim();
    if (name !== undefined && !name) {
      ctx.log('The name cannot be empty.');
      return 2;
    }
    if (name && config.workflows[name]) {
      ctx.log(`A workflow named ${name} already exists.`);
      return 1;
    }
    const missing = [!flags.triggers && '--trigger', !flags.steps && '--steps (or --template)', !flags.project && '--project'].filter(Boolean) as string[];
    let result: { name: string; workflow: Workflow };
    if (missing.length) {
      if (!interactive()) {
        ctx.log(`Missing ${missing.join(', ')}.`);
        ctx.log(usageOf('workflow add'));
        return 2;
      }
      const teams = await teamsOrNull(ctx);
      if (!teams) return 1;
      result = await promptWorkflow(ctx.ui, config, teams, { name, workflow: flags });
    } else {
      const w: Workflow = { triggers: flags.triggers!, steps: flags.steps!, maxRounds: flags.maxRounds!, project: flags.project! };
      name ??= `${w.project}-${p.values.template ?? 'custom'}`;
      if (config.workflows[name]) {
        ctx.log(`Missing NAME. ${name} is already taken.`);
        ctx.log(usageOf('workflow add'));
        return 2;
      }
      result = { name, workflow: w };
    }
    if (config.workflows[result.name]) {
      ctx.log(`A workflow named ${result.name} already exists.`);
      return 1;
    }
    config.workflows[result.name] = result.workflow;
    return saveWorkflow(config, result.name, result.workflow, ctx);
  },

  async show(args, ctx) {
    const p = begin('workflow show', args, { json: { type: 'boolean' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'workflow show', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const name = pickWorkflow(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    const w = config.workflows[name]!;
    if (p.values.json) out(ctx, { name, ...w });
    else {
      ctx.log(`Workflow ${name}: ${describeWorkflow(w)}`);
      for (const t of w.triggers) ctx.log(`Trigger: ${describeTrigger(t)}${t.source === 'cron' ? `, task: ${t.task}` : ''}`);
      ctx.log(`Steps: ${describeSteps(w.steps)}`);
      ctx.log(`Project: ${w.project}`);
      ctx.log(`Rounds: ${w.maxRounds}`);
    }
    return 0;
  },

  async edit(args, ctx) {
    const options = {
      trigger: { type: 'string', multiple: true }, 'add-trigger': { type: 'string', multiple: true }, 'remove-trigger': { type: 'string', multiple: true },
      steps: { type: 'string' }, template: { type: 'string' }, project: { type: 'string' }, rounds: { type: 'string' },
    } as const;
    const p = begin('workflow edit', args, options, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'workflow edit', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const name = pickWorkflow(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    if (inFolder(config, name, ctx)) return 1;
    const flags = readWorkflowFlags(p.values, config);
    if ('error' in flags) {
      ctx.log(flags.error);
      return flags.code;
    }
    const v = p.values;
    const current = config.workflows[name]!;
    if (!Object.keys(flags).length && !v['add-trigger']?.length && !v['remove-trigger']?.length) {
      if (!interactive()) {
        ctx.log('Nothing to change. Give a flag, or run this in a terminal to be asked.');
        ctx.log(usageOf('workflow edit'));
        return 2;
      }
      const teams = await teamsOrNull(ctx);
      if (!teams) return 1;
      const r = await promptWorkflow(ctx.ui, config, teams, { name, workflow: current }, true);
      if (r.name !== name) config.workflows = renameKey(config.workflows, name, r.name);
      config.workflows[r.name] = r.workflow;
      return saveWorkflow(config, r.name, r.workflow, ctx);
    }
    const next: Workflow = { ...current, triggers: [...(flags.triggers ?? current.triggers)] };
    for (const t of (v['add-trigger'] ?? []) as string[]) {
      const parsed = parseTrigger(t);
      if (!parsed) {
        ctx.log(`Bad trigger ${t}. Use ${TRIGGER_FORMS}.`);
        return 2;
      }
      if (!next.triggers.some((x) => sameTrigger(x, parsed))) next.triggers.push(parsed);
    }
    for (const t of (v['remove-trigger'] ?? []) as string[]) {
      const parsed = parseTrigger(t);
      const at = parsed ? next.triggers.findIndex((x) => sameTrigger(x, parsed)) : -1;
      if (at < 0) {
        ctx.log(`${name} has no trigger ${t}.`);
        return 1;
      }
      next.triggers.splice(at, 1);
    }
    if (flags.steps) next.steps = flags.steps;
    if (flags.maxRounds !== undefined) next.maxRounds = flags.maxRounds;
    if (flags.project) next.project = flags.project;
    config.workflows[name] = next;
    return saveWorkflow(config, name, next, ctx);
  },

  async rename(args, ctx) {
    const p = begin('workflow rename', args, {}, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 2, 'workflow rename', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const old = pickWorkflow(config, p.positionals[0]!, ctx);
    if (!old) return 1;
    if (inFolder(config, old, ctx)) return 1;
    const next = p.positionals[1]!.trim();
    if (!next) {
      ctx.log('The new name cannot be empty.');
      return 1;
    }
    if (config.workflows[next]) {
      ctx.log(`A workflow named ${next} already exists.`);
      return 1;
    }
    config.workflows = renameKey(config.workflows, old, next);
    save(ctx, config);
    ctx.log(`Workflow ${old} is now ${next}.`);
    return 0;
  },

  async rm(args, ctx) {
    const p = begin('workflow rm', args, { yes: { type: 'boolean', short: 'y' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'workflow rm', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const name = pickWorkflow(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    if (inFolder(config, name, ctx)) return 1;
    const ok = await confirmed(`Delete workflow ${name}?`, !!p.values.yes, ctx);
    if (ok === 'refused') return 2;
    if (!ok) {
      ctx.log('Nothing deleted.');
      return 0;
    }
    delete config.workflows[name];
    save(ctx, config);
    ctx.log(`Deleted workflow ${name}.`);
    return 0;
  },

  async move(args, ctx) {
    const p = begin('workflow move', args, { first: { type: 'boolean' }, last: { type: 'boolean' }, before: { type: 'string' }, after: { type: 'string' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'workflow move', ctx)) return 2;
    const v = p.values;
    if ([v.first, v.last, v.before, v.after].filter((x) => x !== undefined && x !== false).length !== 1) {
      ctx.log('Give exactly one of --first, --last, --before, --after.');
      ctx.log(usageOf('workflow move'));
      return 2;
    }
    const config = readAgentsConfig(ctx.configDir);
    const name = pickWorkflow(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    if (inFolder(config, name, ctx)) return 1;
    let place: Place;
    if (v.first) place = { first: true };
    else if (v.last) place = { last: true };
    else {
      const other = pickWorkflow(config, v.before ?? v.after, ctx);
      if (!other) return 1;
      if (other === name) {
        ctx.log('Pick a different workflow to put it next to.');
        return 2;
      }
      place = v.before !== undefined ? { before: other } : { after: other };
    }
    config.workflows = moveKey(config.workflows, name, place);
    save(ctx, config);
    listWorkflows(config, ctx);
    return 0;
  },
};

// ---- projects ----

function pickProject(config: AgentsConfig, input: string, ctx: ToolContext): string | null {
  const r = resolveName(Object.keys(config.projects), input, 'project');
  if ('error' in r) {
    ctx.log(r.error);
    return null;
  }
  return r.name;
}

const projectSubs: Record<string, ToolCommand> = {
  async add(args, ctx) {
    const p = begin('project add', args, { path: { type: 'string' }, base: { type: 'string' } }, ctx);
    if (typeof p === 'number') return p;
    if (p.positionals.length > 1) {
      ctx.log('Give at most one name.');
      ctx.log(usageOf('project add'));
      return 2;
    }
    const config = readAgentsConfig(ctx.configDir);
    let name = p.positionals[0]?.trim();
    if (name && config.projects[name]) {
      ctx.log(`A project named ${name} already exists.`);
      return 1;
    }
    let project: Project;
    if (p.values.path !== undefined) {
      const path = resolve(expandHome(p.values.path));
      if (!isRepo(path)) {
        ctx.log(`${tilde(path)} is not a git repository.`);
        return 1;
      }
      name ||= basename(path);
      if (config.projects[name]) {
        ctx.log(`A project named ${name} already exists. Give another name.`);
        return 1;
      }
      let base: string | undefined = p.values.base;
      if (!base) {
        try {
          base = defaultBranch(path);
        } catch {
          // no origin HEAD; the repo's default is used at run time
        }
      }
      project = { path, ...(base ? { base } : {}) };
    } else {
      if (!interactive()) {
        ctx.log('Missing --path.');
        ctx.log(usageOf('project add'));
        return 2;
      }
      const r = await promptProject(ctx.ui, config, { name, base: p.values.base });
      name = r.name;
      project = r.project;
    }
    config.projects[name] = project;
    save(ctx, config);
    ctx.log(`Project ${name}: ${tilde(project.path)}${project.base ? `, PRs into ${project.base}` : ''}`);
    return 0;
  },

  async show(args, ctx) {
    const p = begin('project show', args, { json: { type: 'boolean' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'project show', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const name = pickProject(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    const used = workflowsUsing(config, name);
    if (p.values.json) out(ctx, { name, ...config.projects[name], usedBy: used });
    else {
      const proj = config.projects[name]!;
      ctx.log(`Project ${name}`);
      ctx.log(`Path: ${tilde(proj.path)}`);
      ctx.log(`PRs into: ${proj.base ?? 'the default branch'}`);
      ctx.log(`Used by: ${used.length ? used.join(', ') : 'no workflows'}`);
    }
    return 0;
  },

  async edit(args, ctx) {
    const p = begin('project edit', args, { path: { type: 'string' }, base: { type: 'string' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'project edit', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const name = pickProject(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    const current = config.projects[name]!;
    const v = p.values;
    if (v.path === undefined && v.base === undefined) {
      if (!interactive()) {
        ctx.log('Nothing to change. Give --path or --base, or run this in a terminal to be asked.');
        ctx.log(usageOf('project edit'));
        return 2;
      }
      config.projects[name] = (await promptProject(ctx.ui, config, { name, path: current.path, base: current.base }, true)).project;
    } else {
      const path = v.path !== undefined ? resolve(expandHome(v.path)) : current.path;
      if (!isRepo(path)) {
        ctx.log(`${tilde(path)} is not a git repository.`);
        return 1;
      }
      const next: Project = { ...current, path };
      // An empty --base clears it, so PRs go to the repo's default branch.
      if (v.base !== undefined) {
        if (v.base) next.base = v.base;
        else delete next.base;
      }
      config.projects[name] = next;
    }
    save(ctx, config);
    ctx.log(describeProject(config, name));
    return 0;
  },

  async rename(args, ctx) {
    const p = begin('project rename', args, {}, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 2, 'project rename', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const old = pickProject(config, p.positionals[0]!, ctx);
    if (!old) return 1;
    const next = p.positionals[1]!.trim();
    if (!next) {
      ctx.log('The new name cannot be empty.');
      return 1;
    }
    if (config.projects[next]) {
      ctx.log(`A project named ${next} already exists.`);
      return 1;
    }
    config.projects = renameKey(config.projects, old, next);
    for (const w of Object.values(config.workflows)) if (w.project === old) w.project = next;
    save(ctx, config);
    ctx.log(`Project ${old} is now ${next}.`);
    return 0;
  },

  async rm(args, ctx) {
    const p = begin('project rm', args, { yes: { type: 'boolean', short: 'y' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'project rm', ctx)) return 2;
    const config = readAgentsConfig(ctx.configDir);
    const name = pickProject(config, p.positionals[0]!, ctx);
    if (!name) return 1;
    const used = workflowsUsing(config, name);
    if (used.length) {
      ctx.log(`Used by ${used.join(', ')}. Change or delete those workflows first.`);
      return 1;
    }
    const ok = await confirmed(`Delete project ${name}?`, !!p.values.yes, ctx);
    if (ok === 'refused') return 2;
    if (!ok) {
      ctx.log('Nothing deleted.');
      return 0;
    }
    delete config.projects[name];
    save(ctx, config);
    ctx.log(`Deleted project ${name}.`);
    return 0;
  },
};

// ---- homes ----

// Per enabled agent: ours, taken by something else, or missing.
function homeReport(config: AgentsConfig, h: Home) {
  const wanted = packNames().filter((n) => !config.enabled.length || config.enabled.includes(n));
  const state = (n: string) => (isOurLink(join(h.dir, 'skills', n)) ? 'linked' : exists(join(h.dir, 'skills', n)) ? 'taken' : 'missing');
  return {
    kind: h.kind,
    dir: h.dir,
    linked: wanted.filter((n) => state(n) === 'linked'),
    taken: wanted.filter((n) => state(n) === 'taken'),
    missing: wanted.filter((n) => state(n) === 'missing'),
  };
}

const effectiveEnabled = (config: AgentsConfig) => (config.enabled.length ? config.enabled : packNames());

const homeCommands: Record<string, ToolCommand> = {
  async homes(args, ctx) {
    const p = begin('homes', args, { json: { type: 'boolean' } }, ctx);
    if (typeof p === 'number') return p;
    const config = readAgentsConfig(ctx.configDir);
    const reports = config.homes.map((h) => homeReport(config, h));
    if (p.values.json) {
      out(ctx, reports);
      return 0;
    }
    if (!reports.length) ctx.log('No folders yet. vsf agents link DIR adds one.');
    for (const r of reports) {
      const missing = r.missing.length ? `, missing ${r.missing.join(', ')} (vsf agents link ${tilde(r.dir)})` : '';
      const taken = r.taken.length ? `, ${r.taken.join(', ')} taken by something else` : '';
      ctx.log(`${homeLabel(r)}: ${r.linked.length} linked${missing}${taken}`);
    }
    return 0;
  },

  async link(args, ctx) {
    const p = begin('link', args, { claude: { type: 'boolean' }, codex: { type: 'boolean' } }, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'link', ctx) || (p.values.claude && p.values.codex)) {
      if (p.values.claude && p.values.codex) ctx.log('Use either --claude or --codex, not both.');
      return 2;
    }
    const dir = resolve(expandHome(p.positionals[0]!));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      ctx.log(`${tilde(dir)} is not a folder that exists.`);
      return 1;
    }
    const kind: Home['kind'] = p.values.codex ? 'codex' : p.values.claude ? 'claude' : basename(dir).includes('codex') ? 'codex' : 'claude';
    const config = readAgentsConfig(ctx.configDir);
    let home = config.homes.find((h) => h.dir === dir);
    if (!home) {
      home = { kind, dir };
      config.homes.push(home);
    }
    syncLinks([home], [home], effectiveEnabled(config), ctx.log);
    save(ctx, config);
    return 0;
  },

  async unlink(args, ctx) {
    const p = begin('unlink', args, {}, ctx);
    if (typeof p === 'number') return p;
    if (!needArgs(p, 1, 'unlink', ctx)) return 2;
    const dir = resolve(expandHome(p.positionals[0]!));
    const config = readAgentsConfig(ctx.configDir);
    const home = config.homes.find((h) => h.dir === dir);
    if (!home && !existsSync(dir)) {
      ctx.log(`${tilde(dir)} is not linked.`);
      return 1;
    }
    syncLinks([], [home ?? { kind: 'claude', dir }], [], ctx.log);
    config.homes = config.homes.filter((h) => h.dir !== dir);
    save(ctx, config);
    ctx.log(`Agents removed from ${tilde(dir)}.`);
    return 0;
  },
};

const sameModels = (a: AgentsConfig['models'], b: AgentsConfig['models']) => a.dev === b.dev && a.review === b.review;

const agents: Tool = {
  name: 'agents',
  contract: 1,
  summary: 'Agents for Claude Code and Codex that plan, build and QA Linear cards',

  config: {
    read: (dir) => readAgentsConfig(dir) as unknown as Record<string, unknown>,
    write: (dir, value) => {
      const problems = validateConfig(value, readAgentsConfig(dir));
      if (!problems.length) writeAgentsConfig(dir, value as unknown as AgentsConfig);
      return problems;
    },
  },

  async install(ctx) {
    const { ui } = ctx;
    const config = readAgentsConfig(ctx.configDir);
    if (!candidateHomes(ctx.configDir, config.homes).length) throw new Error('install Claude Code or Codex first');

    const homes = await chooseHomes(ui, ctx.configDir, config.homes);
    if (!homes.length) throw new Error('pick at least one folder to install the agents into');
    const enabled = await ui.multiselect(
      'Which agents do you want?',
      visibleAgents().map((a) => ({ value: a, label: AGENTS[a]!.label, hint: AGENTS[a]!.hint })),
      config.enabled.length ? config.enabled.filter((a) => visibleAgents().includes(a)) : visibleAgents(),
    );
    if (!enabled.length) throw new Error('pick at least one agent');
    syncLinks(homes, candidateHomes(ctx.configDir, [...config.homes, ...homes]), enabled, ctx.log);
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
    // Only swap models that are still the other engine's defaults.
    if (engine !== config.engine) {
      if (engine === 'codex' && sameModels(config.models, DEFAULTS.models)) config.models = {};
      else if (engine === 'claude' && !Object.values(config.models).some(Boolean)) config.models = { ...DEFAULTS.models };
    }
    config.engine = engine;

    // What the runner does to agent commits before pushing them.
    const commits = config.commits ?? {};
    commits.dropAiTrailers = await ui.confirm('Remove AI co-author lines from agent commits?', commits.dropAiTrailers ?? true);
    commits.signOff = await ui.confirm('Sign off agent commits (Signed-off-by, for repos that ask for a DCO)?', commits.signOff ?? false);
    config.commits = commits;

    const name = await currentLinearUser(ctx.configDir);
    if (!name || !(await ui.confirm(`Keep using Linear as ${name}?`))) {
      if (!(await setupKey(ui, ctx.configDir))) throw new Error('Linear is not connected. Run vsf setup agents to retry.');
    }

    await setupProjects(ui, config, ctx.log);
    await setupWorkflows(ui, config, await linear(ctx.configDir).teams(), ctx.log);
    writeAgentsConfig(ctx.configDir, config);
    if (trackersInUse(config).includes('voidtrack') && !readSecret(ctx.configDir, 'voidtrack')) {
      if (!(await setupKey(ui, ctx.configDir, 'voidtrack'))) ctx.log('VoidTrack is not connected yet. Run vsf agents key --voidtrack.');
    }

    if (Object.keys(config.workflows).length && (await ui.confirm('Start the background runner now? Every minute it checks for cards and schedules that start your workflows.'))) {
      const ok = runnerService().start(ctx.home, [...ctx.selfCommand, 'agents', 'tick'], join(agentsDir(ctx.configDir), 'runner.log'));
      ctx.log(ok ? 'Runner started.' : 'Could not start the runner. Try vsf agents start.');
    }
    ctx.log('In Claude Code or Codex, connect Linear too, then use /vs-plan, /vs-plan-review and /vs-publish on a card.');
  },

  async uninstall(ctx) {
    runnerService().stop(ctx.home);
    syncLinks([], candidateHomes(ctx.configDir, readAgentsConfig(ctx.configDir).homes), [], ctx.log);
    ctx.log('Agents unlinked and the runner stopped. Config and the Linear key were kept.');
  },

  async checks(ctx): Promise<Check[]> {
    const checks: Check[] = [];
    const saved = readAgentsConfig(ctx.configDir);
    const homes = saved.homes;
    const wanted = packNames().filter((n) => !saved.enabled.length || saved.enabled.includes(n));
    if (!homes.length) checks.push({ name: 'agents linked', status: 'warn', detail: 'in no Claude Code or Codex folder', fix: 'vsf setup agents' });
    for (const h of homes) {
      const missing = wanted.filter((n) => !isOurLink(join(h.dir, 'skills', n)));
      checks.push(
        missing.length === 0
          ? { name: `agents in ${homeLabel(h)}`, status: 'ok', detail: `${wanted.length} linked` }
          : { name: `agents in ${homeLabel(h)}`, status: 'warn', detail: `missing ${missing.join(', ')}`, fix: `vsf agents link ${tilde(h.dir)}` },
      );
    }
    const inUse = trackersInUse(saved);
    for (const kind of inUse.length ? inUse : (['linear'] as const)) {
      const { name } = TRACKERS[kind];
      try {
        const key = readSecret(ctx.configDir, kind);
        if (!key) throw new Error(`No ${name} API key`);
        const me = await (kind === 'voidtrack' ? createVoidTrack(key) : createLinear(key)).viewer();
        checks.push({ name, status: 'ok', detail: `connected as ${me.name}` });
      } catch (err) {
        checks.push({ name, status: 'fail', detail: (err as Error).message, fix: `vsf agents key${kind === 'linear' ? '' : ` --${kind}`}` });
      }
    }
    const workflows = Object.entries(saved.workflows);
    const broken = workflows.filter(([, c]) => !saved.projects[c.project] || !isRepo(saved.projects[c.project]!.path)).map(([n]) => n);
    checks.push(
      !workflows.length
        ? { name: 'agent workflows', status: 'warn', detail: 'none yet', fix: 'vsf agents workflow add' }
        : broken.length
          ? { name: 'agent workflows', status: 'fail', detail: `${broken.join(', ')} point at a missing project`, fix: 'vsf agents project edit' }
          : { name: 'agent workflows', status: 'ok', detail: `${workflows.length} ready` },
    );
    const folders = agentFolders(ctx.configDir);
    if (folders.length) {
      const bad = folders.filter((d) => validateAgentFolder(d, saved).length).map((d) => basename(d));
      checks.push(
        bad.length
          ? { name: 'agent folders', status: 'fail', detail: `${bad.join(', ')} ${bad.length === 1 ? 'has' : 'have'} problems`, fix: 'vsf agents validate' }
          : { name: 'agent folders', status: 'ok', detail: `${folders.length} valid` },
      );
    }
    return [...checks, ...profileChecks(ctx.configDir), ...(await controlChecks(ctx))];
  },

  commands: {
    ...controlCommands,

    async workflows(args, ctx) {
      const p = begin('workflows', args, { json: { type: 'boolean' } }, ctx);
      if (typeof p === 'number') return p;
      const config = readAgentsConfig(ctx.configDir);
      if (p.values.json) out(ctx, Object.entries(config.workflows).map(([name, w]) => ({ name, ...w, steps: w.steps.map(stepId) })));
      else if (!Object.keys(config.workflows).length) ctx.log('No workflows yet. vsf agents workflow add creates one.');
      else listWorkflows(config, ctx);
      return 0;
    },

    // Hidden, like tick: the step list and workflow templates, for the dashboard's forms.
    async steps(_args, ctx) {
      const steps = (Object.keys(STEPS) as StepId[]).map((id) => ({ id, name: id.replace(/^vs-/, ''), ...STEPS[id] }));
      out(ctx, { steps, templates: TEMPLATES });
      return 0;
    },

    workflow: (args, ctx) => group('workflow', workflowSubs, args, ctx),

    async profile(args, ctx) {
      const p = begin('profile', args, {}, ctx);
      if (typeof p === 'number') return p;
      const dir = profileDir(ctx.configDir);
      if (p.positionals[0] === 'init') {
        const made = initProfile(ctx.configDir);
        ctx.log(made.length ? `Created ${made.join(', ')} in ${tilde(dir)}.` : `${tilde(dir)} already exists; nothing changed.`);
        return 0;
      }
      if (p.positionals.length) {
        ctx.log(usageOf('profile'));
        return 2;
      }
      ctx.log(`Profile: ${tilde(dir)}${existsSync(dir) ? '' : ' (not created yet: vsf agents profile init)'}`);
      const rules = readRules(ctx.configDir).replace(/<!--[\s\S]*?-->/g, '').trim();
      ctx.log(`Rules: ${rules ? `${rules.split('\n').length} lines in ${RULES_FILE}, added to every step's prompt` : 'none'}`);
      let settings = 'none';
      try {
        settings = renderClaudeSettings(ctx.configDir) === null ? 'none' : `${CLAUDE_SETTINGS}, passed to every Claude run`;
      } catch (err) {
        settings = `broken: ${(err as Error).message}`;
      }
      ctx.log(`Claude settings: ${settings}`);
      const c = readAgentsConfig(ctx.configDir).commits ?? {};
      ctx.log(`Commits: ${[c.dropAiTrailers ? 'AI co-author lines removed' : 'AI lines kept', c.signOff ? 'signed off' : 'not signed off'].join(', ')} (commits in the agents config)`);
      return 0;
    },

    async validate(args, ctx) {
      const p = begin('validate', args, {}, ctx);
      if (typeof p === 'number') return p;
      if (p.positionals.length > 1) {
        ctx.log('Give one folder at most.');
        ctx.log(usageOf('validate'));
        return 2;
      }
      const config = readAgentsConfig(ctx.configDir);
      const problems: string[] = [];
      const dirs = p.positionals.length ? [resolve(expandHome(p.positionals[0]!))] : agentFolders(ctx.configDir);
      if (!p.positionals.length) problems.push(...validateConfig(config));
      for (const dir of dirs) for (const line of validateAgentFolder(dir, config)) problems.push(`${basename(dir)}: ${line}`);
      for (const line of problems) ctx.log(line);
      if (!problems.length) ctx.log(p.positionals.length ? `${basename(dirs[0]!)} is valid.` : `Config and ${plural(dirs.length, 'agent folder')} are valid.`);
      return problems.length ? 1 : 0;
    },

    async projects(args, ctx) {
      const p = begin('projects', args, { json: { type: 'boolean' } }, ctx);
      if (typeof p === 'number') return p;
      const config = readAgentsConfig(ctx.configDir);
      if (p.values.json) out(ctx, Object.entries(config.projects).map(([name, pr]) => ({ name, ...pr, usedBy: workflowsUsing(config, name) })));
      else if (!Object.keys(config.projects).length) ctx.log('No projects yet. vsf agents project add creates one.');
      else for (const name of Object.keys(config.projects)) ctx.log(describeProject(config, name));
      return 0;
    },

    project: (args, ctx) => group('project', projectSubs, args, ctx),

    homes: homeCommands.homes!,
    link: homeCommands.link!,
    unlink: homeCommands.unlink!,

    async key(args, ctx) {
      const p = begin('key', args, { voidtrack: { type: 'boolean' } }, ctx);
      if (typeof p === 'number') return p;
      if (p.positionals.length) {
        ctx.log('Keys are not accepted on the command line. Pipe the key in instead.');
        return 2;
      }
      const kind = p.values.voidtrack ? 'voidtrack' : 'linear';
      if (interactive()) return (await setupKey(ctx.ui, ctx.configDir, kind)) ? 0 : 1;
      const key = readFileSync(0, 'utf8').trim();
      if (kind === 'linear' && !looksLikeLinearKey(key)) {
        ctx.log('Linear keys start with lin_api_');
        return 2;
      }
      if (!key) {
        ctx.log('No key on stdin.');
        return 2;
      }
      return (await verifyAndStore(ctx.configDir, key, ctx.log, ctx.log, kind)) ? 0 : 1;
    },

    async help(args, ctx) {
      const want = args.join(' ').trim();
      if (!want) {
        ctx.log(fullUsage());
        return 0;
      }
      const mine = usageOf(want);
      const control = Object.hasOwn(controlUsage, want) ? controlUsage[want] : undefined;
      if (!mine && !control) {
        ctx.log(`No command named ${want}.`);
        ctx.log(fullUsage());
        return 2;
      }
      ctx.log([control, mine].filter(Boolean).join('\n'));
      return 0;
    },
  },
};

export default agents;
