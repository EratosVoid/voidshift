import type { Battery } from './parse.ts';

export interface AwakeState {
  managed: boolean;
  since?: string;
  until?: string;
  batteryFloor: number;
  lastReason?: string;
  // Guardrail switches. Undefined means on.
  heat?: boolean;
  revertOnReboot?: boolean;
}

export interface SystemReading {
  sleepDisabled: boolean;
  battery: Battery;
  thermalSerious: boolean;
  bootTime: Date | null;
}

export type Decision =
  | { action: 'keep' }
  | { action: 'revert'; reason: string }
  | { action: 'forget'; reason: string };

// What the watchdog should do on each tick. 'revert' turns sleep back on;
// 'forget' clears our state when someone else already turned sleep back on.
export function decide(state: AwakeState, sys: SystemReading, now: Date): Decision {
  if (!state.managed) return { action: 'keep' };
  if (!sys.sleepDisabled) return { action: 'forget', reason: 'sleep was turned back on outside VoidShift' };

  const since = state.since ? new Date(state.since) : null;
  if (state.revertOnReboot !== false && since && sys.bootTime && sys.bootTime > since) return { action: 'revert', reason: 'the Mac restarted' };
  if (state.until && now >= new Date(state.until)) return { action: 'revert', reason: 'the timer ended' };
  const { onBattery, percent } = sys.battery;
  if (onBattery && percent !== null && percent <= state.batteryFloor) {
    return { action: 'revert', reason: `battery reached ${percent}%` };
  }
  if (state.heat !== false && sys.thermalSerious) return { action: 'revert', reason: 'the Mac is running too hot' };
  return { action: 'keep' };
}
