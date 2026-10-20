import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from './linear.ts';
import type { Engine } from './engine.ts';

export interface AgentsConfig {
  engine: Engine;
  // Per step model; unset means the engine's default.
  models: { dev?: string; review?: string; ui?: string };
  maxRounds: number;
  // Linear team key or project name -> local repo path.
  repos: Record<string, string>;
  // Team key or project name -> URL where the app runs, for the browser check.
  uiUrls: Record<string, string>;
  // Linear state a verified card moves to.
  reviewState: string;
}

export const DEFAULTS: AgentsConfig = {
  engine: 'claude',
  models: { dev: 'opus', review: 'sonnet', ui: 'sonnet' },
  maxRounds: 3,
  repos: {},
  uiUrls: {},
  reviewState: 'In Review',
};

export const agentsDir = (configDir: string) => join(configDir, 'agents');
const configPath = (configDir: string) => join(agentsDir(configDir), 'config.json');

export function readAgentsConfig(configDir: string): AgentsConfig {
  const path = configPath(configDir);
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentsConfig>;
  return { ...structuredClone(DEFAULTS), ...saved, models: { ...DEFAULTS.models, ...saved.models } };
}

export function writeAgentsConfig(configDir: string, config: AgentsConfig): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(configPath(configDir), JSON.stringify(config, null, 2) + '\n');
}

// Project mapping wins over team mapping, so one team can span repos.
export function lookup(map: Record<string, string>, card: Pick<Card, 'teamKey' | 'projectName'>): string | undefined {
  return (card.projectName && map[card.projectName]) || map[card.teamKey];
}
