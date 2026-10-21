import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Engine } from './engine.ts';

// A step in a chain. Work steps change code; check steps return a verdict.
export type StepId = 'vs-dev' | 'ci' | 'vs-qa-review' | 'vs-qa-ui';

export const STEPS: Record<StepId, { label: string; kind: 'work' | 'check'; hint: string; hidden?: boolean }> = {
  'vs-dev': { label: 'Dev', kind: 'work', hint: 'implements the plan, commits, opens a draft PR' },
  ci: { label: 'CI', kind: 'check', hint: "waits for the PR's checks" },
  'vs-qa-review': { label: 'Code review', kind: 'check', hint: 'reviews the diff against the card and plan' },
  // Off until the runner can start the app from the agent's branch itself.
  'vs-qa-ui': { label: 'Browser check', kind: 'check', hint: "clicks through the app at the project's URL", hidden: true },
};

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
}

// Shipped with VoidShift; custom chains sit beside them.
export const BUILT_IN_CHAINS: Record<string, Chain> = {
  build: { steps: ['vs-dev', 'ci', 'vs-qa-review'], maxRounds: 3 },
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
};

export const agentsDir = (configDir: string) => join(configDir, 'agents');
const configPath = (configDir: string) => join(agentsDir(configDir), 'config.json');

export const allChains = (c: AgentsConfig): Record<string, Chain> => ({ ...BUILT_IN_CHAINS, ...c.chains });
export const hasWork = (chain: Chain) => chain.steps.some((s) => STEPS[s].kind === 'work');
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
