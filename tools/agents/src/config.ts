import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Engine } from './engine.ts';

// A step in a workflow, and what it produces: a plan, a verdict on what came
// before it, commits, or the hand-over of a published plan.
export type StepId = 'vs-plan' | 'vs-plan-review' | 'vs-publish' | 'vs-dev' | 'vs-qa';
export type Output = 'plan' | 'verdict' | 'commits' | 'publish';

export const STEPS: Record<StepId, { label: string; output: Output; hint: string }> = {
  'vs-plan': { label: 'Plan', output: 'plan', hint: 'writes a plan and posts it to the card' },
  'vs-plan-review': { label: 'Plan review', output: 'verdict', hint: 'checks the plan; on FIX the workflow goes back to Plan' },
  'vs-publish': { label: 'Publish', output: 'publish', hint: 'creates and pushes the branch for the card' },
  'vs-dev': { label: 'Dev', output: 'commits', hint: 'implements the plan, commits, opens a draft PR' },
  'vs-qa': { label: 'QA', output: 'verdict', hint: 'CI, then code review, then a usability check; on FIX back to Dev' },
};

// Steps a failed verdict can send work back to.
export const isProducer = (s: StepId) => STEPS[s].output === 'plan' || STEPS[s].output === 'commits';

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

// What starts a workflow: my cards in this Linear team carrying this label.
export interface Trigger {
  source: 'linear';
  team: string;
  label: string;
}

export interface Project {
  path: string;
  // URL where the app runs, for the browser check.
  uiUrl?: string;
}

// A workflow starts on its triggers, runs its steps in order, in its project.
export interface Workflow {
  triggers: Trigger[];
  steps: StepId[];
  // How many times a failed check sends the work back before parking.
  maxRounds: number;
  project: string;
}

export interface AgentsConfig {
  engine: Engine;
  // Per step model; unset means the engine's default.
  models: { dev?: string; review?: string; ui?: string };
  projects: Record<string, Project>;
  workflows: Record<string, Workflow>;
  // Linear state a verified card moves to.
  reviewState: string;
  // Config folders the agents are linked into, e.g. ~/.claude or ~/.codex.
  homes: { kind: 'claude' | 'codex'; dir: string }[];
  // Agents switched on; empty until setup has asked.
  enabled: string[];
}

// Step lists to start a workflow from.
export const TEMPLATES: Record<string, { steps: StepId[]; maxRounds: number }> = {
  build: { steps: ['vs-dev', 'vs-qa'], maxRounds: 3 },
  'plan-and-build': { steps: ['vs-plan', 'vs-plan-review', 'vs-dev', 'vs-qa'], maxRounds: 3 },
  'qa-only': { steps: ['vs-qa'], maxRounds: 1 },
};

export const DEFAULTS: AgentsConfig = {
  engine: 'claude',
  models: { dev: 'opus', review: 'sonnet', ui: 'sonnet' },
  projects: {},
  workflows: {},
  reviewState: 'In Review',
  homes: [],
  enabled: [],
};

export const agentsDir = (configDir: string) => join(configDir, 'agents');
const configPath = (configDir: string) => join(agentsDir(configDir), 'config.json');

export const hasWork = (workflow: Pick<Workflow, 'steps'>) => workflow.steps.some((s) => STEPS[s].output === 'commits');
export const hasProducer = (workflow: Pick<Workflow, 'steps'>) => workflow.steps.some(isProducer);
export const describeSteps = (steps: StepId[]) => steps.map((s) => STEPS[s].label).join(' → ');
export const describeTriggers = (triggers: Trigger[]) => triggers.map((t) => `${t.team} + ${t.label}`).join(', ');
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
  const { repos, uiUrls, maxRounds: _max, triggers, chains, ...rest } = saved;
  const previous: Record<string, any> = saved.workflows ?? chains ?? {};
  const projects: Record<string, Project> = { ...(saved.projects ?? {}) };
  const oldTriggers: { team: string; label: string; chain: string; project: string }[] = [...(triggers ?? [])];
  for (const [team, path] of Object.entries((repos ?? {}) as Record<string, string>)) {
    const name = basename(path);
    projects[name] = { path, uiUrl: uiUrls?.[team] };
    oldTriggers.push({ team, label: 'vs-plan', chain: 'build', project: name });
  }
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
  return { ...rest, projects, workflows, enabled };
}

export function readAgentsConfig(configDir: string): AgentsConfig {
  const path = configPath(configDir);
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  const saved = migrate(JSON.parse(readFileSync(path, 'utf8')));
  return { ...structuredClone(DEFAULTS), ...saved, models: { ...DEFAULTS.models, ...saved.models } };
}

export function writeAgentsConfig(configDir: string, config: AgentsConfig): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(configPath(configDir), JSON.stringify(config, null, 2) + '\n');
}
