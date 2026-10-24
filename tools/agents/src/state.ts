import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir, type Trigger } from './config.ts';

// What a runner process is doing right now, so status, cancel and stop can
// see it. The dispatcher keeps one in runner.lock (older runners wrote only the
// pid there); each card run keeps one in locks/<workspace>.json.
export interface Current {
  pid: number;
  card?: string;
  title?: string;
  workflow?: string;
  // Label of the step running now, e.g. "Dev".
  step?: string;
  // The round now running, 1-based like the card's vs-vN label; 0 before the first.
  round?: number;
  startedAt?: string;
  runDir?: string;
  // Where the card lives; Linear when unset. Cancel writes back there.
  source?: Trigger['source'];
  // The workspace whose queue the run holds; set on workspace locks only.
  workspace?: string;
}

export const lockPath = (configDir: string) => join(agentsDir(configDir), 'runner.lock');

function readLock(path: string): Current | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  try {
    const parsed = JSON.parse(text) as Current | number;
    return typeof parsed === 'number' ? { pid: parsed } : parsed;
  } catch {
    return null;
  }
}

export const readCurrent = (configDir: string): Current | null => readLock(lockPath(configDir));

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

// The live dispatcher, or null when none runs or the lock is stale.
export function liveCurrent(configDir: string): Current | null {
  const c = readCurrent(configDir);
  return c && ours(c.pid) ? c : null;
}

// Whether a lock belongs to a live runner other than this process. A lock from
// before the last boot cannot be a live run, whatever its pid is now.
export function heldByOther(c: Current): boolean {
  const booted = bootTime();
  const fromBeforeBoot = !!(c.startedAt && booted && new Date(c.startedAt) < booted);
  return c.pid !== process.pid && !fromBeforeBoot && ours(c.pid);
}

// One lock per workspace: the run holding its queue.
const locksDir = (configDir: string) => join(agentsDir(configDir), 'locks');
export const workspaceLockPath = (configDir: string, workspace: string) => join(locksDir(configDir), `${encodeURIComponent(workspace)}.json`);

// Takes a workspace's queue for this process. Returns null once taken, or the
// live run that holds it. A stale lock is removed and the take tried again.
// The file is created exclusively, so two runners never both take it.
export function acquireWorkspace(configDir: string, workspace: string, current: Omit<Current, 'workspace'>): Current | null {
  mkdirSync(locksDir(configDir), { recursive: true });
  const path = workspaceLockPath(configDir, workspace);
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ ...current, workspace }) + '\n', { flag: 'wx' });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = readLock(path);
    if (held && heldByOther(held)) return held;
    if (attempt) return held ?? { pid: 0, workspace };
    rmSync(path, { force: true });
  }
}

// Updates the lock of a queue this process holds.
export function writeWorkspace(configDir: string, workspace: string, current: Omit<Current, 'workspace'>): void {
  mkdirSync(locksDir(configDir), { recursive: true });
  writeFileSync(workspaceLockPath(configDir, workspace), JSON.stringify({ ...current, workspace }) + '\n');
}

export const releaseWorkspace = (configDir: string, workspace: string) => rmSync(workspaceLockPath(configDir, workspace), { force: true });

// Every workspace lock on disk, stale ones included.
export function workspaceLocks(configDir: string): Current[] {
  let names: string[];
  try {
    names = readdirSync(locksDir(configDir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.map((n) => readLock(join(locksDir(configDir), n))).filter((c): c is Current => !!c);
}

// The card runs going on now, one per busy workspace.
export const liveRuns = (configDir: string): Current[] => workspaceLocks(configDir).filter((c) => ours(c.pid));

// Releases the lock a run left behind, wherever it lives.
export const clearLock = (configDir: string, c: Current) => (c.workspace ? releaseWorkspace(configDir, c.workspace) : clearCurrent(configDir));

// Paused: the runner stays loaded but picks up no new cards.
const pausePath = (configDir: string) => join(agentsDir(configDir), 'paused');
export const isPaused = (configDir: string) => existsSync(pausePath(configDir));
export function setPaused(configDir: string, paused: boolean): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  if (paused) writeFileSync(pausePath(configDir), new Date().toISOString() + '\n');
  else rmSync(pausePath(configDir), { force: true });
}

// The Claude subscription's 5 hour window as last read, so status and every
// pass can see it without asking again.
export interface Window {
  checkedAt: string;
  // Percent used, 0 to 100.
  utilization?: number;
  resetsAt?: string;
  // Why the last read failed; an older reading may still be kept.
  error?: string;
}

const windowPath = (configDir: string) => join(agentsDir(configDir), 'window.json');

export function readWindow(configDir: string): Window | null {
  try {
    return JSON.parse(readFileSync(windowPath(configDir), 'utf8')) as Window;
  } catch {
    return null;
  }
}

export function writeWindow(configDir: string, w: Window): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(windowPath(configDir), JSON.stringify(w, null, 2) + '\n');
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
  // The card's tracker; Linear when unset.
  source?: 'linear' | 'voidtrack';
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
// The runner alone writes it. verified: a card run whose checks all passed.
// done: a scheduled run that finished. failed: a step's process failed, or the
// run ended without finishing.
export type Outcome = 'running' | 'verified' | 'done' | 'changes' | 'parked' | 'failed' | 'cancelled';

// Tokens and cost of one step, or added up over a run. Codex steps carry only
// the model. Cost is what Claude reports, an estimate.
export interface Usage {
  input?: number;
  output?: number;
  // Cache reads and writes.
  cached?: number;
  costUsd?: number;
  // The model a step spent the most on.
  model?: string;
}

// A run's usage: every step added up, and each model once.
export type RunUsage = Omit<Usage, 'model'> & { models?: string[] };

export function addUsage(total: RunUsage | undefined, step: Usage): RunUsage {
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const out: RunUsage = {};
  const input = sum(total?.input, step.input);
  const output = sum(total?.output, step.output);
  const cached = sum(total?.cached, step.cached);
  const costUsd = sum(total?.costUsd, step.costUsd);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cached !== undefined) out.cached = cached;
  if (costUsd !== undefined) out.costUsd = costUsd;
  const models = [...new Set([...(total?.models ?? []), ...(step.model ? [step.model] : [])])];
  if (models.length) out.models = models;
  return out;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m';
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

// "12.3k in, 4.1k out, 1.2M cached, $0.42 est.", or empty with nothing to show.
export function usageText(u: Usage | RunUsage | undefined): string {
  if (!u) return '';
  const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
  const parts: string[] = [];
  if (u.input !== undefined) parts.push(`${n(u.input)} in`);
  if (u.output !== undefined) parts.push(`${n(u.output)} out`);
  if (u.cached) parts.push(`${n(u.cached)} cached`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)} est.`);
  return parts.join(', ');
}

export interface StepRecord {
  // A built-in step id, or a custom step's id.
  step: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  // SHIP, FIX or SKIP for checks; done or blocked for Plan and Dev.
  result?: string;
  // First lines of what the agent reported.
  summary?: string;
  // File name of the step's log inside the run folder.
  log?: string;
  usage?: Usage;
  // Cards this step handed to another workflow.
  handoffs?: string[];
}

export interface RunRecord {
  card: string;
  title: string;
  url?: string;
  workflow: string;
  // The trigger label, or the schedule for a scheduled run.
  trigger: string;
  source?: Trigger['source'];
  steps: StepRecord[];
  outcome: Outcome;
  reason?: string;
  prUrl?: string;
  // The workspace whose queue the run took.
  workspace?: string;
  startedAt: string;
  endedAt?: string;
  usage?: RunUsage;
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

// When each schedule last fired, by workflow and schedule, so a restart or a
// busy runner never fires one twice.
const cronPath = (configDir: string) => join(agentsDir(configDir), 'cron.json');

export function readCronState(configDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(cronPath(configDir), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeCronState(configDir: string, state: Record<string, string>): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(cronPath(configDir), JSON.stringify(state, null, 2) + '\n');
}

// Cards a step handed to another workflow, waiting for the runner to start
// them. An entry leaves the queue once its run has started.
export interface Handoff {
  card: string;
  workflow: string;
  // The run that handed it over.
  from: string;
  at: string;
}

const handoffsPath = (configDir: string) => join(agentsDir(configDir), 'handoffs.json');

export function readHandoffs(configDir: string): Handoff[] {
  try {
    return JSON.parse(readFileSync(handoffsPath(configDir), 'utf8')) as Handoff[];
  } catch {
    return [];
  }
}

export function writeHandoffs(configDir: string, handoffs: Handoff[]): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  if (handoffs.length) writeFileSync(handoffsPath(configDir), JSON.stringify(handoffs, null, 2) + '\n');
  else rmSync(handoffsPath(configDir), { force: true });
}

// Queues cards for a workflow, once each: a card already waiting for it is skipped.
export function queueHandoffs(configDir: string, workflow: string, cards: string[], from: string, now = new Date()): Handoff[] {
  const queue = readHandoffs(configDir);
  const added: Handoff[] = [];
  for (const card of cards) {
    if (queue.some((h) => h.card === card && h.workflow === workflow)) continue;
    const h = { card, workflow, from, at: now.toISOString() };
    queue.push(h);
    added.push(h);
  }
  if (added.length) writeHandoffs(configDir, queue);
  return added;
}

// Takes a card off the queue once its run for the workflow has started.
export function takeHandoff(configDir: string, card: string, workflow: string): void {
  const queue = readHandoffs(configDir);
  const left = queue.filter((h) => !(h.card === card && h.workflow === workflow));
  if (left.length !== queue.length) writeHandoffs(configDir, left);
}

// When a run that ended without finishing last showed signs of life: its last
// step's end or start, else its start.
export function lastSeen(run: RunRecord): string {
  const last = run.steps.at(-1);
  return last?.endedAt ?? last?.startedAt ?? run.startedAt;
}

export const STOPPED_REASON = 'The run stopped without finishing: its process ended before it could record an outcome.';

// Closes runs that say "running" while no live run holds them: their process
// is gone, so they failed. `live` is the run folders live runs hold, and
// `cards` the cards of live runs whose lock names no folder. Returns the cards closed.
export function closeStale(configDir: string, live: { runDir?: string; card?: string }[]): string[] {
  const closed: string[] = [];
  for (const e of listRuns(configDir)) {
    const r = e.record;
    if (!r || r.outcome !== 'running') continue;
    if (live.some((l) => (l.runDir ? l.runDir === e.dir : l.card === e.card))) continue;
    const steps = r.steps.map((s) => (s.endedAt ? s : { ...s, endedAt: lastSeen(r), result: s.result ?? 'stopped' }));
    try {
      writeRun(e.dir, { ...r, steps, outcome: 'failed', reason: r.reason ?? STOPPED_REASON, endedAt: lastSeen({ ...r, steps }) });
      closed.push(e.card);
    } catch {
      // the folder is gone
    }
  }
  return closed;
}
