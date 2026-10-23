import { existsSync, readFileSync } from 'node:fs';
import * as launchd from './launchd.ts';
import * as systemd from './systemd.ts';
import type { Check } from './types.ts';

// The background runner, whatever schedules it on this platform: a launchd
// agent on macOS, a systemd user timer on Linux.
export interface RunnerService {
  loaded(): boolean;
  start(home: string, program: string[], logPath: string): boolean;
  stop(home: string): void;
  // The command the installed job runs, or null when none is installed.
  programArgs(home: string): string[] | null;
  checks(): Check[];
}

const mac: RunnerService = {
  loaded: launchd.runnerLoaded,
  start: launchd.startRunner,
  stop: launchd.stopRunner,
  programArgs: (home) => (existsSync(launchd.plistPath(home)) ? launchd.parsePlistArgs(readFileSync(launchd.plistPath(home), 'utf8')) : null),
  checks: () => [],
};

const linux: RunnerService = {
  loaded: systemd.runnerLoaded,
  start: (home, program, logPath) => systemd.startRunner(home, program, launchd.runnerEnv(), logPath),
  stop: systemd.stopRunner,
  programArgs: systemd.programArgs,
  checks: () => [systemd.lingerCheck()],
};

export const runnerService = (platform: NodeJS.Platform = process.platform): RunnerService => (platform === 'darwin' ? mac : linux);
