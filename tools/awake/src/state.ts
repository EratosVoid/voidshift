import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AwakeState } from './decide.ts';

export const DEFAULT_BATTERY_FLOOR = 20;

export const stateDir = (configDir: string) => join(configDir, 'awake');
export const statePath = (configDir: string) => join(stateDir(configDir), 'state.json');
export const logPath = (configDir: string) => join(stateDir(configDir), 'watchdog.log');

export function readState(configDir: string): AwakeState {
  const path = statePath(configDir);
  if (!existsSync(path)) return { managed: false, batteryFloor: DEFAULT_BATTERY_FLOOR };
  return JSON.parse(readFileSync(path, 'utf8')) as AwakeState;
}

export function writeState(configDir: string, state: AwakeState): void {
  const path = statePath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}
