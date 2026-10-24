import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from './engine.ts';

// A step in a workflow, and what it produces: a plan, a verdict on what came
// before it, commits, the hand-over of a published plan, or nothing the
// workflow reads (a step that only does its job).
export type StepId = 'vs-plan' | 'vs-plan-review' | 'vs-publish' | 'vs-dev' | 'vs-qa';
export type Output = 'plan' | 'verdict' | 'commits' | 'publish' | 'none';
export const OUTPUTS: Output[] = ['plan', 'verdict', 'commits', 'publish', 'none'];

// The built-in steps, the vs-* template. `write` is whether the agent may
// edit files; `role` picks the model from config.models.
export const STEPS: Record<StepId, { label: string; output: Output; hint: string; write: boolean; role: 'dev' | 'review' }> = {
  'vs-plan': { label: 'Plan', output: 'plan', hint: 'writes a plan and posts it to the card', write: false, role: 'dev' },
  'vs-plan-review': { label: 'Plan review', output: 'verdict', hint: 'checks the plan; on FIX the workflow goes back to Plan', write: false, role: 'review' },
  'vs-publish': { label: 'Publish', output: 'publish', hint: 'creates and pushes the branch for the card', write: false, role: 'dev' },
  'vs-dev': { label: 'Dev', output: 'commits', hint: 'implements the plan, commits, opens a draft PR', write: true, role: 'dev' },
  'vs-qa': { label: 'QA', output: 'verdict', hint: 'CI, then code review, then a usability check; on FIX back to Dev', write: true, role: 'review' },
};

// A step an agent folder defines: a prompt file or a skill, with its own
// engine, model, timeout and write access. Unset fields fall back to the
// config, and `write` to true only for a step that makes commits.
export interface StepDef {
  id: string;
  label?: string;
  // A pack skill name, or a folder (relative to the agent folder) with a SKILL.md.
  skill?: string;
  // A prompt file, relative to the agent folder.
  prompt?: string;
  // A shell command run in place of an agent: exit 0 is done, anything else
  // fails the run. Its last line of output is the step's summary.
  run?: string;
  // A workflow the step hands cards to: every `HANDOFF: CARD-12` line in its
  // output queues that card there as a run of its own.
  handoff?: string;
  output: Output;
  engine?: Engine;
  model?: string;
  timeoutMinutes?: number;
  write?: boolean;
}

// A built-in step by id, or a step an agent folder defines.
export type Step = StepId | StepDef;

// What a custom step id may look like.
export const STEP_ID = /^[a-z0-9][a-z0-9-]*$/;

export const isBuiltin = (id: string): id is StepId => Object.hasOwn(STEPS, id);
export const outputOf = (s: Step): Output => (typeof s === 'string' ? STEPS[s].output : s.output);
export const stepId = (s: Step): string => (typeof s === 'string' ? s : s.id);
export const stepLabel = (s: Step): string => (typeof s === 'string' ? STEPS[s]?.label ?? s : s.label ?? s.id);
export const stepIdLabel = (id: string): string => (isBuiltin(id) ? STEPS[id].label : id);

// Steps a failed verdict can send work back to.
export const isProducer = (s: Step) => outputOf(s) === 'plan' || outputOf(s) === 'commits';

// The agents in the pack, as setup describes them.
export const AGENTS: Record<string, { label: string; hint: string }> = {
  'vs-plan': { label: 'Plan', hint: 'plans a card against the code' },
  'vs-plan-review': { label: 'Plan review', hint: 'checks a plan before it is published' },
  'vs-publish': { label: 'Publish', hint: 'posts the plan to Linear and hands the card over' },
  'vs-dev': { label: 'Dev', hint: 'implements the plan and opens a draft PR' },
  'vs-qa': { label: 'QA', hint: 'CI, then code review, then a usability check' },
};

export const visibleAgents = () => Object.keys(AGENTS);

export const stepEnabled = (step: StepId, enabled: string[]) => enabled.includes(step);

// What starts a workflow: my cards in a Linear or VoidTrack team carrying a
// label, or a schedule that runs the workflow on a standing task, no card.
export type Tracker = 'linear' | 'voidtrack';
export interface CardTrigger {
  source: Tracker;
  team: string;
  label: string;
}
export interface CronTrigger {
  source: 'cron';
  // Five fields, minute hour day month weekday, in the machine's time zone.
  schedule: string;
  // What the run works on, in place of a card.
  task: string;
}
export type Trigger = CardTrigger | CronTrigger;

export const isCardTrigger = (t: Trigger): t is CardTrigger => t.source !== 'cron';

// The form `--trigger` takes: "ENG:vs-plan" (Linear), "voidtrack:ORG:vs-start",
// or "cron:0 5 * * 1:Update the dependencies".
export function triggerSpec(t: Trigger): string {
  if (t.source === 'cron') return `cron:${t.schedule}:${t.task}`;
  return t.source === 'voidtrack' ? `voidtrack:${t.team}:${t.label}` : `${t.team}:${t.label}`;
}

export function describeTrigger(t: Trigger): string {
  if (t.source === 'cron') return `cron ${t.schedule}`;
  return `${t.source === 'voidtrack' ? 'VoidTrack ' : ''}${t.team} + ${t.label}`;
}

export interface Project {
  path: string;
  // Branch pull requests go into; the repo's default branch when unset.
  base?: string;
  // The workspace whose queue its runs wait in; the default one when unset.
  workspace?: string;
  // Tracker project names whose cards run here, whatever the workflow's project.
  match?: string[];
}

// A workspace is a folder of repos with one run queue: cards in different
// workspaces run side by side, two in one workspace one after the other.
export interface Workspace {
  root: string;
  // A file every step's prompt carries; <root>/CONTEXT.md when unset.
  context?: string;
}

export const DEFAULT_WORKSPACE = 'default';
export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const workspaceOf = (project: Pick<Project, 'workspace'> | undefined) => project?.workspace || DEFAULT_WORKSPACE;

// What a card run writes back to the tracker. Unset keeps the defaults: stage
// labels on, the card moved to reviewState when the workflow makes commits,
// and a closing comment.
export interface WriteBack {
  labels?: boolean;
  // A state to move a verified card to; null never moves it.
  state?: string | null;
  comment?: boolean;
  // One comment per finished custom step; on unless false.
  steps?: boolean;
}

// A workflow starts on its triggers, runs its steps in order, in its project.
export interface Workflow {
  triggers: Trigger[];
  steps: Step[];
  // How many times a failed check sends the work back before parking.
  maxRounds: number;
  project: string;
  writeBack?: WriteBack;
}

export interface AgentsConfig {
  engine: Engine;
  // Per step model; unset means the engine's default.
  models: { dev?: string; review?: string };
  projects: Record<string, Project>;
  workspaces: Record<string, Workspace>;
  workflows: Record<string, Workflow>;
  // Linear state a verified card moves to.
  reviewState: string;
  // How long one agent step may run before it is stopped.
  timeoutMinutes: number;
  // Config folders the agents are linked into, e.g. ~/.claude or ~/.codex.
  homes: { kind: 'claude' | 'codex'; dir: string }[];
  // Agents switched on; empty until setup has asked.
  enabled: string[];
  // What the runner does to agent commits before pushing them.
  commits?: { signOff?: boolean; dropAiTrailers?: boolean };
  // Most card runs at once over every workspace; 0 means no cap.
  maxRuns?: number;
  // Percent of the Claude 5 hour window at which no new run starts; 0 never holds.
  pauseAt?: number;
  // Workflows read from agent folders, by name, to their folder. Never saved.
  folders?: Record<string, string>;
}

// Step lists to start a workflow from.
export const TEMPLATES: Record<string, { steps: StepId[]; maxRounds: number }> = {
  build: { steps: ['vs-dev', 'vs-qa'], maxRounds: 3 },
  'plan-and-build': { steps: ['vs-plan', 'vs-plan-review', 'vs-dev', 'vs-qa'], maxRounds: 3 },
  'qa-only': { steps: ['vs-qa'], maxRounds: 1 },
};

export const DEFAULTS: AgentsConfig = {
  engine: 'claude',
  models: { dev: 'opus', review: 'sonnet' },
  projects: {},
  workspaces: {},
  workflows: {},
  reviewState: 'In Review',
  timeoutMinutes: 45,
  homes: [],
  enabled: [],
  maxRuns: 0,
  pauseAt: 90,
};

export const agentsDir = (configDir: string) => join(configDir, 'agents');
const configPath = (configDir: string) => join(agentsDir(configDir), 'config.json');

export const hasWork = (workflow: Pick<Workflow, 'steps'>) => workflow.steps.some((s) => outputOf(s) === 'commits');
export const hasProducer = (workflow: Pick<Workflow, 'steps'>) => workflow.steps.some(isProducer);
export const describeSteps = (steps: Step[]) => steps.map(stepLabel).join(' → ');
export const describeTriggers = (triggers: Trigger[]) => triggers.map(describeTrigger).join(', ');
export const describeWorkflow = (c: Workflow) => `when ${describeTriggers(c.triggers)}: ${describeSteps(c.steps)} in ${c.project}`;

// Step ids that were folded into QA.
const RENAMED: Record<string, StepId | null> = { 'vs-qa-review': 'vs-qa', ci: null, 'vs-qa-ui': null };
const migrateStepList = (steps: string[]): StepId[] => {
  const mapped = steps.map((s) => (s in RENAMED ? RENAMED[s] : s)).filter((s): s is StepId => !!s);
  return mapped.filter((s, i) => !(s === 'vs-qa' && mapped[i - 1] === 'vs-qa'));
};

// Earlier shapes: a team mapped straight to a repo, then separate triggers
// pointing at a workflow and a project. Both become workflows that own triggers.
// Saved settings used to call workflows "chains".
export function migrate(saved: Record<string, any>): Partial<AgentsConfig> {
  const { repos, uiUrls: _uiUrls, maxRounds: _max, triggers, chains, ...rest } = saved;
  const previous: Record<string, any> = saved.workflows ?? chains ?? {};
  const projects: Record<string, Project> = { ...(saved.projects ?? {}) };
  const oldTriggers: { team: string; label: string; chain: string; project: string }[] = [...(triggers ?? [])];
  for (const [team, path] of Object.entries((repos ?? {}) as Record<string, string>)) {
    const name = basename(path);
    projects[name] = { path };
    oldTriggers.push({ team, label: 'vs-plan', chain: 'build', project: name });
  }
  // The browser check is gone, so its URL and model are dead settings.
  for (const p of Object.values(projects)) delete (p as { uiUrl?: unknown }).uiUrl;
  const models = rest.models && { ...rest.models };
  if (models) delete models.ui;
  const workflows: Record<string, Workflow> = {};
  for (const [name, w] of Object.entries(previous)) {
    if (w.project) workflows[name] = { ...w, steps: migrateStepList(w.steps) };
  }
  for (const t of oldTriggers) {
    const base = t.chain === 'review-only' ? 'qa-only' : t.chain;
    const steps = TEMPLATES[base]?.steps ?? migrateStepList(previous[t.chain]?.steps ?? []);
    if (!steps.length) continue;
    const name = `${t.project}-${base}`;
    const workflow = workflows[name] ?? { triggers: [], steps, maxRounds: TEMPLATES[base]?.maxRounds ?? previous[t.chain]?.maxRounds ?? 3, project: t.project };
    workflow.triggers.push({ source: 'linear', team: t.team, label: t.label });
    workflows[name] = workflow;
  }
  const enabled = [...new Set((saved.enabled ?? []).map((a: string) => (a in RENAMED ? RENAMED[a] : a)).filter(Boolean))] as string[];
  return { ...rest, ...(models ? { models } : {}), projects, workflows, enabled };
}

// Agent folders: defs/<name>/agent.json, with its prompt files next to it.
export const defsDir = (configDir: string) => join(agentsDir(configDir), 'defs');
export const AGENT_FILE = 'agent.json';

export function agentFolders(configDir: string): string[] {
  try {
    return readdirSync(defsDir(configDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(defsDir(configDir), e.name));
  } catch {
    return [];
  }
}

// The workflow in an agent folder. Throws when agent.json is missing or not JSON.
export function readAgentFolder(dir: string): Workflow {
  const value = JSON.parse(readFileSync(join(dir, AGENT_FILE), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${AGENT_FILE} must be an object`);
  const { triggers, steps, maxRounds, project, writeBack } = value as Workflow;
  return { triggers, steps, maxRounds, project, ...(writeBack !== undefined ? { writeBack } : {}) };
}

export function readAgentsConfig(configDir: string): AgentsConfig {
  const path = configPath(configDir);
  let config = structuredClone(DEFAULTS);
  if (existsSync(path)) {
    const saved = migrate(JSON.parse(readFileSync(path, 'utf8')));
    config = { ...config, ...saved, models: { ...DEFAULTS.models, ...saved.models } };
  }
  // A name config.json already uses wins, and a broken folder is skipped:
  // `vsf agents validate` reports both.
  for (const dir of agentFolders(configDir)) {
    const name = basename(dir);
    if (config.workflows[name]) continue;
    try {
      config.workflows[name] = readAgentFolder(dir);
      config.folders = { ...config.folders, [name]: dir };
    } catch {
      // skipped
    }
  }
  return config;
}

export function writeAgentsConfig(configDir: string, config: AgentsConfig): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  const { folders, ...rest } = config;
  const workflows = Object.fromEntries(Object.entries(config.workflows).filter(([name]) => !folders?.[name]));
  writeFileSync(configPath(configDir), JSON.stringify({ ...rest, workflows }, null, 2) + '\n');
}

// Every workspace a config uses: the named ones, then any a project names,
// the default one included.
export const workspacesInUse = (config: Pick<AgentsConfig, 'projects' | 'workspaces'>): string[] => [
  ...new Set([...Object.keys(config.workspaces ?? {}), ...Object.values(config.projects).map(workspaceOf)]),
];

// Whether a match entry names a tracker project: the whole name, or its first
// word, so "DS06" matches "DS06 Atleurope ERP". Case does not matter.
export function matchesProject(entry: string, projectName: string): boolean {
  const want = entry.trim().toLowerCase();
  const name = projectName.trim().toLowerCase();
  return !!want && (want === name || want === name.split(/\s+/)[0]);
}

// The project a card runs in. Explicit matches on the card's tracker project
// come first, in every workspace, and only then the workflow's own project.
// A scheduled run has no tracker project, so it always takes the workflow's.
export function resolveProject(config: Pick<AgentsConfig, 'projects'>, workflow: Pick<Workflow, 'project'>, card: { projectName?: string }): { name: string; project: Project } | null {
  if (card.projectName) {
    for (const [name, project] of Object.entries(config.projects)) {
      if (project.match?.some((m) => matchesProject(m, card.projectName!))) return { name, project };
    }
  }
  const project = config.projects[workflow.project];
  return project ? { name: workflow.project, project } : null;
}

// The workspace's context text for the step prompts: its context file, or
// CONTEXT.md in its root. Empty when there is none.
export function workspaceContext(config: Pick<AgentsConfig, 'workspaces'>, name: string): string {
  const ws = config.workspaces?.[name];
  if (!ws) return '';
  const file = ws.context ? resolve(ws.root, ws.context) : join(ws.root, 'CONTEXT.md');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// One step with every setting it runs with filled in.
export interface ResolvedStep {
  id: string;
  label: string;
  output: Output;
  engine: Engine;
  model?: string;
  timeoutMs: number;
  write: boolean;
  // The prompt or SKILL.md text, read when the step runs.
  prompt: () => string;
  // Set for the built-in steps, whose CI wait, labels and skips stay theirs.
  builtin?: StepId;
  // A command step's shell command; such a step runs no agent.
  command?: string;
  // The workflow its HANDOFF lines queue cards for.
  handoff?: string;
}

const packDir = fileURLToPath(new URL('../pack/', import.meta.url));
const packSkill = (name: string) => join(packDir, name, 'SKILL.md');

// The file a custom step's prompt comes from: its prompt file, a pack skill,
// or a skill folder next to agent.json. Null for a step with neither.
export function stepFile(step: StepDef, dir = '.'): string | null {
  if (step.prompt) return resolve(dir, step.prompt);
  if (!step.skill) return null;
  if (STEP_ID.test(step.skill) && existsSync(packSkill(step.skill))) return packSkill(step.skill);
  return resolve(dir, step.skill, 'SKILL.md');
}

export function resolveStep(step: Step, config: Pick<AgentsConfig, 'engine' | 'models' | 'timeoutMinutes'>, dir?: string): ResolvedStep {
  if (typeof step === 'string') {
    const s = STEPS[step];
    return {
      id: step, label: s.label, output: s.output, engine: config.engine, model: config.models[s.role],
      timeoutMs: config.timeoutMinutes * 60_000, write: s.write, prompt: () => readFileSync(packSkill(step), 'utf8'), builtin: step,
    };
  }
  // A command step runs a shell command, so it has no prompt.
  if (step.run) {
    return {
      id: step.id, label: step.label ?? step.id, output: step.output, engine: step.engine ?? config.engine,
      model: step.model ?? config.models.dev, timeoutMs: (step.timeoutMinutes ?? config.timeoutMinutes) * 60_000,
      write: step.write ?? false, command: step.run, prompt: () => '', handoff: step.handoff,
    };
  }
  return {
    id: step.id,
    label: step.label ?? step.id,
    output: step.output,
    engine: step.engine ?? config.engine,
    model: step.model ?? config.models[step.output === 'verdict' ? 'review' : 'dev'],
    timeoutMs: (step.timeoutMinutes ?? config.timeoutMinutes) * 60_000,
    write: step.write ?? step.output === 'commits',
    prompt: () => {
      const file = stepFile(step, dir);
      if (!file) throw new Error(`Step ${step.id} has no prompt or skill.`);
      return readFileSync(file, 'utf8');
    },
    handoff: step.handoff,
  };
}
