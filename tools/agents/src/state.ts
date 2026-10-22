import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir, type StepId } from './config.ts';

// What the runner is doing right now, kept in runner.lock so status, cancel
// and stop can see it. Older runners wrote only the pid.
export interface Current {
  pid: number;
  card?: string;
  title?: string;
  workflow?: string;
  // Label of the step running now, e.g. "Dev".
  step?: string;
  // Times the work has been sent back so far.
  round?: number;
  startedAt?: string;
  runDir?: string;
}

export const lockPath = (configDir: string) => join(agentsDir(configDir), 'runner.lock');

export function readCurrent(configDir: string): Current | null {
  const path = lockPath(configDir);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  try {
    const parsed = JSON.parse(text) as Current | number;
    return typeof parsed === 'number' ? { pid: parsed } : parsed;
  } catch {
    return null;
  }
}

export function writeCurrent(configDir: string, current: Current): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(lockPath(configDir), JSON.stringify(current) + '\n');
}

export const clearCurrent = (configDir: string) => rmSync(lockPath(configDir), { force: true });

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// True only when the pid is alive and is our runner ("agents tick" or
// "agents run"). After a reboot the old pid can belong to any program.
export function ours(pid: number): boolean {
  if (!alive(pid)) return false;
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return / agents (tick|run)\b/.test(r.stdout ?? '');
}

// When the machine last booted, or null when it cannot be read.
export function bootTime(): Date | null {
  const r = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
  const sec = /sec = (\d+)/.exec(r.stdout ?? '')?.[1];
  return sec ? new Date(Number(sec) * 1000) : null;
}

// The live run, or null when nothing runs or the lock is stale.
export function liveCurrent(configDir: string): Current | null {
  const c = readCurrent(configDir);
  return c && ours(c.pid) ? c : null;
}

// Paused: the runner stays loaded but picks up no new cards.
const pausePath = (configDir: string) => join(agentsDir(configDir), 'paused');
export const isPaused = (configDir: string) => existsSync(pausePath(configDir));
export function setPaused(configDir: string, paused: boolean): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  if (paused) writeFileSync(pausePath(configDir), new Date().toISOString() + '\n');
  else rmSync(pausePath(configDir), { force: true });
}

// Linear writes that failed (Linear was down when a card parked) and are
// retried at the start of the next tick.
export interface Pending {
  card: string;
  comment: string;
  // Labels to drop and add on the card's labels as they are then.
  drop: string[];
  add: string[];
  // Also drop every VoidShift status label the card carries then.
  dropStatus?: boolean;
}

const pendingPath = (configDir: string) => join(agentsDir(configDir), 'pending.json');

export function readPending(configDir: string): Pending[] {
  try {
    return JSON.parse(readFileSync(pendingPath(configDir), 'utf8')) as Pending[];
  } catch {
    return [];
  }
}

export function writePending(configDir: string, pending: Pending[]): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  if (pending.length) writeFileSync(pendingPath(configDir), JSON.stringify(pending, null, 2) + '\n');
  else rmSync(pendingPath(configDir), { force: true });
}

// One card's pass through a workflow, saved as run.json in its run folder.
export type Outcome = 'running' | 'verified' | 'changes' | 'parked' | 'cancelled';

export interface StepRecord {
  step: StepId;
  label: string;
  startedAt: string;
  endedAt?: string;
  // SHIP, FIX or SKIP for checks; done or blocked for Plan and Dev.
  result?: string;
  // First lines of what the agent reported.
  summary?: string;
  // File name of the step's log inside the run folder.
  log?: string;
}

export interface RunRecord {
  card: string;
  title: string;
  url?: string;
  workflow: string;
  trigger: string;
  steps: StepRecord[];
  outcome: Outcome;
  reason?: string;
  prUrl?: string;
  startedAt: string;
  endedAt?: string;
}

export const runsDir = (configDir: string) => join(agentsDir(configDir), 'runs');

export function writeRun(runDir: string, run: RunRecord): void {
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
}

export interface RunEntry {
  card: string;
  // Folder name, an ISO-like timestamp.
  stamp: string;
  dir: string;
  // Missing for runs made before run.json existed.
  record?: RunRecord;
  logs: string[];
}

// Every saved run, newest first. Pass a card to limit it to that card.
export function listRuns(configDir: string, card?: string): RunEntry[] {
  const root = runsDir(configDir);
  // Skip stray files such as .DS_Store at both levels.
  const dirs = (path: string) => readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const cards = card ? [card] : existsSync(root) ? dirs(root) : [];
  const out: RunEntry[] = [];
  for (const c of cards) {
    const dir = join(root, c);
    if (!existsSync(dir)) continue;
    for (const stamp of dirs(dir)) {
      const runDir = join(dir, stamp);
      let record: RunRecord | undefined;
      try {
        record = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunRecord;
      } catch {
        // an older run, logs only
      }
      const logs = readdirSync(runDir).filter((f) => f.endsWith('.log')).sort();
      out.push({ card: c, stamp, dir: runDir, record, logs });
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}
