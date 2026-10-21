import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Engine } from './engine.ts';

// A step in a chain, and what it produces: a plan, a verdict on what came
// before it, commits, or the hand-over of a published plan.
export type StepId = 'vs-plan' | 'vs-plan-review' | 'vs-publish' | 'vs-dev' | 'ci' | 'vs-qa-review' | 'vs-qa-ui';
export type Output = 'plan' | 'verdict' | 'commits' | 'publish';

export const STEPS: Record<StepId, { label: string; output: Output; hint: string; hidden?: boolean }> = {
  'vs-plan': { label: 'Plan', output: 'plan', hint: 'writes a plan and posts it to the card' },
  'vs-plan-review': { label: 'Plan review', output: 'verdict', hint: 'checks the plan; on FIX the chain goes back to Plan' },
  'vs-publish': { label: 'Publish', output: 'publish', hint: 'creates and pushes the branch for the card' },
  'vs-dev': { label: 'Dev', output: 'commits', hint: 'implements the plan, commits, opens a draft PR' },
  ci: { label: 'CI', output: 'verdict', hint: "waits for the PR's checks; on FIX back to Dev" },
  'vs-qa-review': { label: 'Code review', output: 'verdict', hint: 'reviews the change; on FIX back to Dev' },
  // Off until the runner can start the app from the agent's branch itself.
  'vs-qa-ui': { label: 'Browser check', output: 'verdict', hint: "clicks through the app at the project's URL", hidden: true },
};

// Steps a failed verdict can send work back to.
export const isProducer = (s: StepId) => STEPS[s].output === 'plan' || STEPS[s].output === 'commits';

// The agents in the pack, as setup describes them.
export const AGENTS: Record<string, { label: string; hint: string; hidden?: boolean }> = {
  'vs-plan': { label: 'Plan', hint: 'plans a card against the code' },
  'vs-plan-review': { label: 'Plan review', hint: 'checks a plan before it is published' },
  'vs-publish': { label: 'Publish', hint: 'posts the plan to Linear and hands the card over' },
  'vs-dev': { label: 'Dev', hint: 'implements the plan and opens a draft PR' },
  'vs-qa-review': { label: 'Code review', hint: 'reviews the change against the card and plan' },
  'vs-qa-ui': { label: 'Browser check', hint: 'clicks through the app', hidden: true },
};

export const visibleAgents = () => Object.keys(AGENTS).filter((a) => !AGENTS[a]!.hidden);

// CI is built into the runner, so it never needs enabling.
export const stepEnabled = (step: StepId, enabled: string[]) => step === 'ci' || enabled.includes(step);

export interface Chain {
  steps: StepId[];
  // How many times a failed check sends the work back before parking.
  maxRounds: number;
}

export interface Project {
  path: string;
  // URL where the app runs, for the browser check.
  uiUrl?: string;
}

export interface Trigger {
  source: 'linear';
  team: string;
  label: string;
  chain: string;
  project: string;
}

export interface AgentsConfig {
  engine: Engine;
  // Per step model; unset means the engine's default.
  models: { dev?: string; review?: string; ui?: string };
  projects: Record<string, Project>;
  chains: Record<string, Chain>;
  triggers: Trigger[];
  // Linear state a verified card moves to.
  reviewState: string;
  // Config folders the agents are linked into, e.g. ~/.claude or ~/.codex.
  homes: { kind: 'claude' | 'codex'; dir: string }[];
  // Agents switched on; empty until setup has asked.
  enabled: string[];
}

// Shipped with VoidShift; custom chains sit beside them.
export const BUILT_IN_CHAINS: Record<string, Chain> = {
  build: { steps: ['vs-dev', 'ci', 'vs-qa-review'], maxRounds: 3 },
  'plan-and-build': { steps: ['vs-plan', 'vs-plan-review', 'vs-dev', 'ci', 'vs-qa-review'], maxRounds: 3 },
  'review-only': { steps: ['ci', 'vs-qa-review'], maxRounds: 1 },
};

export const DEFAULTS: AgentsConfig = {
  engine: 'claude',
  models: { dev: 'opus', review: 'sonnet', ui: 'sonnet' },
  projects: {},
  chains: {},
  triggers: [],
  reviewState: 'In Review',
  homes: [],
  enabled: [],
};

export const agentsDir = (configDir: string) => join(configDir, 'agents');
const configPath = (configDir: string) => join(agentsDir(configDir), 'config.json');

export const allChains = (c: AgentsConfig): Record<string, Chain> => ({ ...BUILT_IN_CHAINS, ...c.chains });
export const hasWork = (chain: Chain) => chain.steps.some((s) => STEPS[s].output === 'commits');
export const hasProducer = (chain: Chain) => chain.steps.some(isProducer);
export const describeChain = (chain: Chain) => chain.steps.map((s) => STEPS[s].label).join(' → ');

// Older configs mapped a team straight to a repo; turn each into a project and
// a build trigger on the vs-plan label.
export function migrate(saved: Record<string, any>): Partial<AgentsConfig> {
  if (!saved.repos || saved.triggers) return saved;
  const projects: Record<string, Project> = {};
  const triggers: Trigger[] = [];
  for (const [team, path] of Object.entries(saved.repos as Record<string, string>)) {
    const name = basename(path);
    projects[name] = { path, uiUrl: saved.uiUrls?.[team] };
    triggers.push({ source: 'linear', team, label: 'vs-plan', chain: 'build', project: name });
  }
  const { repos: _repos, uiUrls: _ui, maxRounds: _max, ...rest } = saved;
  return { ...rest, projects, triggers };
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
