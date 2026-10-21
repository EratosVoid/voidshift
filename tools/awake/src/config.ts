import { DEFAULT_BATTERY_FLOOR, readState, writeState } from './state.ts';

export type AwakeConfig = {
  battery: number;
  heat: boolean;
  revertOnReboot: boolean;
};

const KEYS = ['battery', 'heat', 'revertOnReboot'];

// Returns the problems with a proposed config change; empty means it is fine.
export function validateConfig(value: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (!KEYS.includes(key)) problems.push(`Unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
    else if (key === 'battery' && !(typeof v === 'number' && Number.isInteger(v) && v >= 5 && v <= 95)) {
      problems.push('battery must be a whole number from 5 to 95.');
    } else if (key !== 'battery' && typeof v !== 'boolean') problems.push(`${key} must be true or false.`);
  }
  return problems;
}

export function readConfig(configDir: string): AwakeConfig {
  const s = readState(configDir);
  return { battery: s.batteryFloor, heat: s.heat !== false, revertOnReboot: s.revertOnReboot !== false };
}

export function writeConfig(configDir: string, value: Record<string, unknown>): string[] {
  const problems = validateConfig(value);
  if (problems.length) return problems;
  const state = readState(configDir);
  // The written value is the whole config: a missing key goes back to its default.
  state.batteryFloor = (value.battery as number | undefined) ?? DEFAULT_BATTERY_FLOOR;
  state.heat = value.heat as boolean | undefined;
  state.revertOnReboot = value.revertOnReboot as boolean | undefined;
  writeState(configDir, state);
  return [];
}
