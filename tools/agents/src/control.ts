import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentsDir, isCardTrigger, readAgentsConfig, workspaceOf, workspacesInUse, type AgentsConfig, type Tracker as Kind } from './config.ts';
import { isPaused, listRuns, ours, clearLock, liveCurrent, liveRuns, readCurrent, setPaused, workspaceLocks, writeRun, type Current, type RunEntry } from './state.ts';
import { runnerService } from './service.ts';
import { TRACKERS, trackersFor, type Tracker, type Trackers } from './tracker.ts';
import type { Card } from './linear.ts';
import { parseFrom, resolveName, stepNames } from './names.ts';
import { isStatusLabel } from './workflow.ts';
import { cancelCard, dispatch, tick } from './runner.ts';
import { notifyRun, notifyRunner, sendSummary, type RunEvent } from './notify.ts';
import type { Check, ToolCommand, ToolContext } from './types.ts';

const HOUR = 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CARD_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ISO_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s*(.*)$/;

export { parsePlistArgs } from './launchd.ts';

// Trackers the workflows' card triggers use.
export const trackersInUse = (config: Pick<AgentsConfig, 'workflows'>): Kind[] => [
  ...new Set(Object.values(config.workflows).flatMap((w) => w.triggers.filter(isCardTrigger).map((t) => t.source))),
];

// A card by id, from the tracker of a workflow that starts on its team.
async function findCard(config: AgentsConfig, trackers: Trackers, id: string): Promise<{ card: Card; tracker: Tracker; source: Kind }> {
  const team = id.split('-')[0]!.toUpperCase();
  const sources = [...new Set(Object.values(config.workflows).flatMap((w) => w.triggers.filter(isCardTrigger).filter((t) => t.team === team).map((t) => t.source)))];
  if (!sources.length) throw new Error(`No workflow starts on team ${team}.`);
  let last: Error | null = null;
  for (const source of sources) {
    try {
      const tracker = trackers(source);
      return { card: await tracker.card(id), tracker, source };
    } catch (err) {
      last = err as Error;
    }
  }
  throw last!;
}

const logPath = (configDir: string) => join(agentsDir(configDir), 'runner.log');
const program = (ctx: ToolContext) => [...ctx.selfCommand, 'agents', 'tick'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// "14d" or "36h" as milliseconds, null when it is neither.
export function parseAge(input: string): number | null {
  const m = /^(\d+)([dh])$/.exec(input.trim());
  if (!m || !Number(m[1])) return null;
  return Number(m[1]) * (m[2] === 'd' ? 24 * HOUR : HOUR);
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m';
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

// Run folders are named like 2026-10-20T14-03-00-123Z.
export function stampDate(stamp: string): Date {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/.exec(stamp);
  return new Date(m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : stamp);
}

const when = (d: Date) => (isNaN(d.getTime()) ? '?' : `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock(d)}`);

const VERDICTS = new Set(['SHIP', 'FIX', 'SKIP']);

// Times a check sent the work back. A round is a run of consecutive verdict steps.
export function countRounds(steps: { result?: string }[]): number {
  let rounds = 0;
  let inRound = false;
  let hasFix = false;
  for (const s of steps) {
    const verdict = VERDICTS.has(s.result ?? '');
    if (verdict && !inRound) hasFix = false;
    if (verdict && s.result === 'FIX' && !hasFix) {
      hasFix = true;
      rounds++;
    }
    inRound = verdict;
  }
  return rounds;
}

// A run that says 'running' but is none of the live runs was cut off.
export const isInterrupted = (e: RunEntry, live: Current[]): boolean =>
  e.record?.outcome === 'running' && !live.some((l) => (l.runDir ? l.runDir === e.dir : l.card === e.card));

export function formatRunLine(e: RunEntry, now = Date.now(), live: Current[] = []): string {
  const r = e.record;
  if (!r) return `${e.card}  ${when(stampDate(e.stamp))}  older run, logs only (${plural(e.logs.length, 'log')})`;
  const rounds = countRounds(r.steps);
  const end = r.endedAt ? Date.parse(r.endedAt) : now;
  const parts = [e.card, when(new Date(r.startedAt)), r.workflow, r.steps.map((s) => s.label).join(' → '), isInterrupted(e, live) ? 'interrupted' : r.outcome];
  if (rounds) parts.push(plural(rounds, 'round'));
  parts.push(formatDuration(end - Date.parse(r.startedAt)));
  return parts.join('  ');
}

// Lines from the last hour that look like failures.
export function scanRunnerErrors(text: string, now: number): { count: number; last: string } {
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    const m = ISO_LINE.exec(line);
    if (!m || now - Date.parse(m[1]!) > HOUR || Date.parse(m[1]!) > now + HOUR) continue;
    if (/Could not|Error|went wrong/.test(line)) bad.push(line);
  }
  return { count: bad.length, last: bad.at(-1) ?? '' };
}

function lastTickOf(text: string): { at: string; line: string } | null {
  for (const line of text.split('\n').reverse()) {
    const m = ISO_LINE.exec(line);
    if (m) return { at: m[1]!, line: m[2]! };
  }
  return null;
}

const readLog = (configDir: string) => {
  try {
    return readFileSync(logPath(configDir), 'utf8');
  } catch {
    return '';
  }
};

const USAGE: Record<string, string> = {
  status: 'status [--json]   Runner, the card each workspace is on, parked cards and workflows',
  start: 'start   Start the background runner',
  stop: 'stop   Stop the runner and cancel the cards it is working on',
  restart: 'restart   Stop and start the runner',
  pause: 'pause   Pick up no new cards; a card in progress carries on',
  resume: 'resume   Pick up new cards again',
  run: 'run [CARD] [--workflow W] [--from STEP]   Run now instead of waiting for the next minute',
  cancel: 'cancel [CARD]   Stop a card being worked on and clear its labels',
  retry: 'retry CARD [--workflow W]   Queue a parked or cancelled card again',
  runs: 'runs [CARD] [--limit N] [--json]   Past runs, newest first',
  show: 'show CARD [--json]   Steps, outcome and labels of the latest run',
  logs: 'logs [CARD] [--step N] [-f] [--lines N]   Runner log, or a card\'s step logs',
  clean: 'clean [--older 14d] [--yes]   Remove old worktrees and run folders',
};

// One usage line per command, in the order help lists them.
export const controlUsage: Record<string, string> = USAGE;

type Opts = NonNullable<Parameters<typeof parseArgs>[0]>['options'];
type Parsed = { values: Record<string, any>; positionals: string[] };

// Bad input or --help ends the command: the number is its exit code.
function parse(name: string, args: string[], options: Opts, ctx: ToolContext): Parsed | number {
  const usage = `vsf agents ${USAGE[name]}`;
  try {
    const { values, positionals } = parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
    if (values.help) {
      ctx.log(usage);
      return 0;
    }
    return { values, positionals };
  } catch (err) {
    ctx.log((err as Error).message.split('\n')[0]!);
    ctx.log(usage);
    return 2;
  }
}

const usageError = (name: string, ctx: ToolContext, why: string) => {
  ctx.log(why);
  ctx.log(`vsf agents ${USAGE[name]}`);
  return 2;
};

const guard = (fn: ToolCommand): ToolCommand => async (args, ctx) => {
  try {
    return await fn(args, ctx);
  } catch (err) {
    ctx.log((err as Error).message);
    return 1;
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function runnerState(ctx: ToolContext): 'running' | 'paused' | 'stopped' {
  if (!runnerService().loaded()) return 'stopped';
  return isPaused(ctx.configDir) ? 'paused' : 'running';
}

export interface CancelDeps {
  ours: (pid: number) => boolean;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  sleep: (ms: number) => Promise<void>;
  cancelCard: (card: string, label: string, source: Kind) => Promise<boolean>;
}

// Ends the work behind the lock. Only ever signals a pid that is our runner.
export async function cancelCurrent(ctx: ToolContext, c: Current, deps: CancelDeps): Promise<void> {
  if (deps.ours(c.pid)) {
    // The runner's own handler takes the working label off the card.
    try {
      deps.kill(c.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    for (let i = 0; i < 50 && deps.ours(c.pid); i++) await deps.sleep(200);
    if (deps.ours(c.pid)) {
      try {
        deps.kill(c.pid, 'SIGKILL');
      } catch {
        // gone just now
      }
    }
    ctx.log(c.card ? `Cancelled ${c.card}.` : 'Stopped a check.');
    return;
  }
  // Dead or a reused pid: no signal, just tidy up what it left behind.
  if (c.card && c.runDir) {
    try {
      const run = listRuns(ctx.configDir, c.card).find((e) => e.dir === c.runDir)?.record;
      if (run && run.outcome === 'running') writeRun(c.runDir, { ...run, outcome: 'cancelled', endedAt: new Date().toISOString() });
    } catch {
      // the record is only a nicety
    }
  }
  if (c.card && c.source !== 'cron') {
    const first = readAgentsConfig(ctx.configDir).workflows[c.workflow ?? '']?.triggers.find(isCardTrigger);
    await deps.cancelCard(c.card, first?.label ?? "the workflow's label", c.source ?? 'linear');
    ctx.log(`Cleared a stale lock and cancelled ${c.card}.`);
  } else ctx.log('Cleared a stale lock.');
  clearLock(ctx.configDir, c);
}

const realDeps = (ctx: ToolContext): CancelDeps => ({
  ours,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep,
  cancelCard: async (card, label, source) => {
    try {
      return await cancelCard(trackersFor(ctx.configDir)(source), ctx.configDir, card, label, source);
    } catch {
      return false;
    }
  },
});

// One message per tracker whose key is missing or refused. The tick skips a
// tracker it cannot open, so these warn rather than stop the runner.
export async function trackerWarnings(kinds: Kind[], trackers: Trackers): Promise<{ kind: Kind; message: string }[]> {
  const out: { kind: Kind; message: string }[] = [];
  for (const kind of kinds) {
    try {
      await trackers(kind).viewer();
    } catch (err) {
      const msg = (err as Error).message;
      const flag = kind === 'linear' ? '' : ` --${kind}`;
      out.push({ kind, message: /^No .* API key/.test(msg) ? msg : `${TRACKERS[kind].name} did not accept the key: ${msg}. Run vsf agents key${flag}.` });
    }
  }
  return out;
}

// Pauses or resumes the runner, and pings Discord only when that changed something.
export async function changePaused(ctx: Pick<ToolContext, 'configDir' | 'log'>, paused: boolean, reason: string, fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<void> {
  const was = isPaused(ctx.configDir);
  setPaused(ctx.configDir, paused);
  if (was !== paused) await notifyRunner(ctx.configDir, paused, reason, ctx.log, fetcher, platform);
}

async function startCmd(ctx: ToolContext): Promise<number> {
  if (!Object.keys(readAgentsConfig(ctx.configDir).workflows).length) {
    ctx.log('No workflows yet. Create one first: vsf agents workflow add.');
    return 1;
  }
  for (const w of await trackerWarnings(trackersInUse(readAgentsConfig(ctx.configDir)), trackersFor(ctx.configDir))) {
    ctx.log(`Warning: ${w.message.replace(/\.?$/, '.')} Workflows on ${TRACKERS[w.kind].name} are skipped until then.`);
  }
  await changePaused(ctx, false, 'by vsf agents start');
  if (!runnerService().start(ctx.home, program(ctx), logPath(ctx.configDir))) {
    ctx.log('Could not start the runner. Check vsf agents logs.');
    return 1;
  }
  return 0;
}

async function stopCmd(ctx: ToolContext): Promise<number> {
  runnerService().stop(ctx.home);
  // Stopping the runner may have stopped its runs; finish or tidy up whatever the locks still name.
  for (const c of workspaceLocks(ctx.configDir)) await cancelCurrent(ctx, c, realDeps(ctx));
  const c = readCurrent(ctx.configDir);
  if (c) await cancelCurrent(ctx, c, realDeps(ctx));
  ctx.log('Runner stopped.');
  return 0;
}

// The lock holds the round as the card's vs-vN label shows it; 0 before any round.
export function workingLine(current: (Current & { elapsedMinutes: number }) | null): string {
  if (!current) return '';
  if (!current.card) return ' Checking now.';
  return ` Working on ${current.card}${current.title ? ` "${current.title}"` : ''} (${[current.workflow, current.step, current.round ? `round ${current.round}` : '', `${current.elapsedMinutes}m`].filter(Boolean).join(', ')}).`;
}

const elapsed = (c: Current) => (c.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(c.startedAt)) / 60_000)) : 0);

// One line per workspace: the card it is on, or idle.
export function workspaceLines(workspaces: string[], running: (Current & { elapsedMinutes: number })[]): string[] {
  const names = [...new Set([...workspaces, ...running.map((r) => workspaceOf(r))])];
  return names.map((ws) => `  ${ws}:${workingLine(running.find((r) => workspaceOf(r) === ws) ?? null) || ' idle.'}`);
}

const status = guard(async (args, ctx) => {
  const p = parse('status', args, { json: { type: 'boolean' } }, ctx);
  if (typeof p === 'number') return p;
  const config = readAgentsConfig(ctx.configDir);
  const runner = runnerState(ctx);
  const text = readLog(ctx.configDir);
  const lastTick = lastTickOf(text);
  const live = liveRuns(ctx.configDir);
  const running = live.map((c) => ({ ...c, workspace: workspaceOf(c), elapsedMinutes: elapsed(c) }));
  const dispatcher = liveCurrent(ctx.configDir);
  // The first run, or the dispatcher checking for work, for dashboards that know one run only.
  const current = running.length ? { ...running[0]!, checking: false } : dispatcher ? { ...dispatcher, checking: true, elapsedMinutes: elapsed(dispatcher) } : null;
  const seen = new Set<string>();
  const parked: { card: string; reason?: string }[] = [];
  const interrupted: string[] = [];
  for (const e of listRuns(ctx.configDir)) {
    if (e.record?.outcome === 'running' && isInterrupted(e, live)) interrupted.push(e.card);
    if (seen.has(e.card)) continue;
    seen.add(e.card);
    if (e.record?.outcome === 'parked') parked.push({ card: e.card, reason: e.record.reason });
  }
  const workflows = Object.keys(config.workflows).length;
  const projects = Object.keys(config.projects).length;
  if (p.values.json) {
    ctx.log(JSON.stringify({ engine: config.engine, runner, lastTick, current, running, parked, interrupted, workflows, projects }, null, 2));
    return 0;
  }
  // One workspace keeps the single line; several get a line each.
  const workspaces = workspacesInUse(config);
  const perWorkspace = runner !== 'stopped' && (workspaces.length > 1 || running.some((r) => !workspaces.includes(r.workspace)));
  const working = perWorkspace ? '' : workingLine(current);
  if (runner === 'running') ctx.log(`Runner: running.${working}`);
  else if (runner === 'paused') ctx.log(`Runner: paused, picks up no new cards. vsf agents resume to continue.${working}`);
  else ctx.log('Runner: stopped. vsf agents start to begin.');
  if (perWorkspace) for (const line of workspaceLines(workspaces, running)) ctx.log(line);
  if (lastTick) ctx.log(`Last check: ${clock(new Date(lastTick.at))}, ${lastTick.line.replace(/\.$/, '') || 'no details'}.`);
  for (const card of interrupted) ctx.log(`Interrupted: ${card}. vsf agents retry ${card} to run it again.`);
  for (const k of parked) ctx.log(`Parked: ${k.card}${k.reason ? ` (${k.reason.replace(/\.$/, '')})` : ''}. vsf agents retry ${k.card} after fixing the cause.`);
  ctx.log(`${plural(workflows, 'workflow')}, ${plural(projects, 'project')}. vsf agents workflows lists them.`);
  return 0;
});

const start = guard(async (args, ctx) => {
  const p = parse('start', args, {}, ctx);
  if (typeof p === 'number') return p;
  const code = await startCmd(ctx);
  if (!code) ctx.log('Runner started. Every minute it checks for cards and schedules that start your workflows.');
  return code;
});

const stop = guard(async (args, ctx) => {
  const p = parse('stop', args, {}, ctx);
  return typeof p === 'number' ? p : stopCmd(ctx);
});

const restart = guard(async (args, ctx) => {
  const p = parse('restart', args, {}, ctx);
  if (typeof p === 'number') return p;
  await stopCmd(ctx);
  const code = await startCmd(ctx);
  if (!code) ctx.log('Runner restarted.');
  return code;
});

const pause = guard(async (args, ctx) => {
  const p = parse('pause', args, {}, ctx);
  if (typeof p === 'number') return p;
  await changePaused(ctx, true, 'by vsf agents pause');
  ctx.log('Paused. The runner picks up no new cards; a card in progress carries on. vsf agents resume to continue.');
  return 0;
});

const resume = guard(async (args, ctx) => {
  const p = parse('resume', args, {}, ctx);
  if (typeof p === 'number') return p;
  await changePaused(ctx, false, 'by vsf agents resume');
  ctx.log('Resumed.');
  return 0;
});

const run = guard(async (args, ctx) => {
  const p = parse('run', args, { workflow: { type: 'string' }, from: { type: 'string' } }, ctx);
  if (typeof p === 'number') return p;
  if (p.positionals.length > 1) return usageError('run', ctx, 'Give one card at most.');
  const card = p.positionals[0]?.toUpperCase();
  if (card && !CARD_ID.test(card)) return usageError('run', ctx, `${p.positionals[0]} is not a card id like ENG-12.`);
  if (p.values.from && !card) return usageError('run', ctx, '--from needs a card.');
  const config = readAgentsConfig(ctx.configDir);
  let workflow: string | undefined;
  if (p.values.workflow) {
    const r = resolveName(Object.keys(config.workflows), p.values.workflow, 'workflow');
    if ('error' in r) {
      ctx.log(r.error);
      return 1;
    }
    workflow = r.name;
  }
  let from;
  if (p.values.from) {
    from = parseFrom(p.values.from);
    if (!from) {
      ctx.log(`Unknown step ${p.values.from}. Steps: ${stepNames()}.`);
      return 2;
    }
  }
  const code = await tick({ configDir: ctx.configDir, config, trackers: trackersFor(ctx.configDir), log: ctx.log, selfCommand: ctx.selfCommand }, card, { workflow, from });
  if (!card && code === 0) {
    if (isPaused(ctx.configDir)) ctx.log('The runner is paused, so nothing was picked up. vsf agents resume, or name a card.');
    else ctx.log('Nothing to do, or the card was verified.');
  }
  return code;
});

// The lock a cancel ends, or why there is none. Every run's lock counts, stale
// ones included, so a dead run can be tidied up; with none, the dispatcher's
// own lock, a check in progress. Without a card it must be the only one.
export function pickCancel(locks: Current[], dispatcher: Current | null, card?: string): Current | string {
  const all = locks.length ? locks : dispatcher ? [dispatcher] : [];
  if (!all.length) return card ? `${card} is not running.` : 'Nothing is running.';
  const name = (l: Current) => `${l.card ?? 'a check'}${l.workspace ? ` in ${l.workspace}` : ''}`;
  if (card) return all.find((l) => l.card === card) ?? `${card} is not running. Running: ${all.map(name).join(', ')}.`;
  if (all.length > 1) return `More than one card is running: ${all.map(name).join(', ')}. Name one: vsf agents cancel CARD.`;
  return all[0]!;
}

const cancel = guard(async (args, ctx) => {
  const p = parse('cancel', args, {}, ctx);
  if (typeof p === 'number') return p;
  const card = p.positionals[0]?.toUpperCase();
  if (p.positionals.length > 1 || (card && !CARD_ID.test(card))) return usageError('cancel', ctx, 'Give one card id like ENG-12.');
  const found = pickCancel(workspaceLocks(ctx.configDir), readCurrent(ctx.configDir), card);
  if (typeof found === 'string') {
    ctx.log(found);
    return found.startsWith('More than one') ? 2 : card ? 1 : 0;
  }
  await cancelCurrent(ctx, found, realDeps(ctx));
  return 0;
});

const retry = guard(async (args, ctx) => {
  const p = parse('retry', args, { workflow: { type: 'string' } }, ctx);
  if (typeof p === 'number') return p;
  const id = p.positionals[0]?.toUpperCase();
  if (p.positionals.length !== 1 || !CARD_ID.test(id!)) return usageError('retry', ctx, 'Give one card id like ENG-12.');
  if (liveRuns(ctx.configDir).some((c) => c.card === id)) {
    ctx.log(`${id} is running now. vsf agents cancel ${id} first.`);
    return 1;
  }
  const config = readAgentsConfig(ctx.configDir);
  const names = Object.keys(config.workflows);
  let found: Awaited<ReturnType<typeof findCard>>;
  try {
    found = await findCard(config, trackersFor(ctx.configDir), id!);
  } catch (err) {
    ctx.log((err as Error).message);
    return 1;
  }
  const { card, source } = found;
  const l = found.tracker;
  const startsOn = (n: string) => config.workflows[n]!.triggers.some((t) => isCardTrigger(t) && t.source === source && t.team === card.teamKey);
  let chosen: string;
  if (p.values.workflow) {
    const r = resolveName(names, p.values.workflow, 'workflow');
    if ('error' in r) {
      ctx.log(r.error);
      return 1;
    }
    if (!startsOn(r.name)) {
      ctx.log(`No workflow starts on team ${card.teamKey}.`);
      return 1;
    }
    chosen = r.name;
  } else {
    const candidates = names.filter(startsOn);
    if (!candidates.length) {
      ctx.log(`No workflow starts on team ${card.teamKey}.`);
      return 1;
    }
    if (candidates.length > 1) {
      ctx.log(`More than one workflow starts on team ${card.teamKey}: ${candidates.join(', ')}.`);
      ctx.log('Pass --workflow NAME.');
      return 2;
    }
    chosen = candidates[0]!;
  }
  const label = config.workflows[chosen]!.triggers.filter(isCardTrigger).find((t) => t.source === source && t.team === card.teamKey)!.label;
  const next = card.labels.filter((n) => !isStatusLabel(n));
  if (!next.includes(label)) next.push(label);
  await l.setLabels(card, next);
  const state = runnerState(ctx);
  ctx.log(
    `${card.identifier} queued again for ${chosen}. The runner picks it up within a minute.` +
      (state === 'paused' ? ' The runner is paused: vsf agents resume.' : state === 'stopped' ? ' The runner is stopped: vsf agents start.' : ''),
  );
  return 0;
});

const runs = guard(async (args, ctx) => {
  const p = parse('runs', args, { limit: { type: 'string' }, json: { type: 'boolean' } }, ctx);
  if (typeof p === 'number') return p;
  const card = p.positionals[0]?.toUpperCase();
  if (p.positionals.length > 1 || (card && !CARD_ID.test(card))) return usageError('runs', ctx, 'Give one card id like ENG-12.');
  const limit = p.values.limit === undefined ? 20 : Number(p.values.limit);
  if (!Number.isInteger(limit) || limit < 1) return usageError('runs', ctx, '--limit needs a whole number above 0.');
  const entries = listRuns(ctx.configDir, card).slice(0, limit);
  if (p.values.json) {
    ctx.log(JSON.stringify(entries.map((e) => ({ card: e.card, stamp: e.stamp, dir: e.dir, logs: e.logs, record: e.record })), null, 2));
    return 0;
  }
  if (!entries.length) ctx.log('No runs yet.');
  const live = liveRuns(ctx.configDir);
  for (const e of entries) ctx.log(formatRunLine(e, Date.now(), live));
  return 0;
});

const oneLine = (s: string, max = 100) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

const show = guard(async (args, ctx) => {
  const p = parse('show', args, { json: { type: 'boolean' } }, ctx);
  if (typeof p === 'number') return p;
  const id = p.positionals[0]?.toUpperCase();
  if (p.positionals.length !== 1 || !CARD_ID.test(id!)) return usageError('show', ctx, 'Give one card id like ENG-12.');
  const all = listRuns(ctx.configDir, id);
  const latest = all[0]?.record;
  if (!latest) {
    ctx.log(`No runs for ${id}.`);
    return 1;
  }
  let labels: string[] | null = null;
  try {
    labels = (await findCard(readAgentsConfig(ctx.configDir), trackersFor(ctx.configDir), id!)).card.labels;
  } catch {
    // live labels are optional
  }
  if (p.values.json) {
    ctx.log(JSON.stringify({ card: id, latest, runs: all.length, labels }, null, 2));
    return 0;
  }
  ctx.log(`${latest.card}  ${latest.title}`);
  ctx.log(`Workflow ${latest.workflow}, ${isInterrupted(all[0]!, liveRuns(ctx.configDir)) ? 'interrupted' : latest.outcome}${latest.prUrl ? `, PR ${latest.prUrl}` : ''}`);
  if (labels) ctx.log(`Labels: ${labels.join(', ') || 'none'}`);
  for (const s of latest.steps) {
    const took = s.endedAt ? formatDuration(Date.parse(s.endedAt) - Date.parse(s.startedAt)) : 'running';
    ctx.log(`  ${s.label.padEnd(12)} ${(s.result ?? 'running').toLowerCase().padEnd(8)} ${took.padEnd(6)} ${oneLine(s.summary ?? '')}`.trimEnd());
  }
  if (latest.outcome === 'parked' && latest.reason) ctx.log(`Parked: ${oneLine(latest.reason, 300)}`);
  if (all.length > 1) ctx.log(`${plural(all.length, 'run')} in total. vsf agents runs ${id} lists them.`);
  return 0;
});

// Prints bytes appended to a file; a card's follow also hops to a newer log.
async function follow(file: string, offset: number, newer?: () => string | null): Promise<void> {
  for (;;) {
    await sleep(1000);
    const next = newer?.();
    if (next && next !== file) {
      file = next;
      offset = 0;
    }
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    const n = readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset += n;
    process.stdout.write(buf.subarray(0, n));
  }
}

const logs = guard(async (args, ctx) => {
  const p = parse('logs', args, { step: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, lines: { type: 'string' } }, ctx);
  if (typeof p === 'number') return p;
  const card = p.positionals[0]?.toUpperCase();
  if (p.positionals.length > 1 || (card && !CARD_ID.test(card))) return usageError('logs', ctx, 'Give one card id like ENG-12.');
  const lines = p.values.lines === undefined ? undefined : Number(p.values.lines);
  if (lines !== undefined && (!Number.isInteger(lines) || lines < 1)) return usageError('logs', ctx, '--lines needs a whole number above 0.');
  const step = p.values.step === undefined ? undefined : Number(p.values.step);
  if (step !== undefined && (!Number.isInteger(step) || step < 1)) return usageError('logs', ctx, '--step needs a whole number above 0.');

  if (!card) {
    const file = logPath(ctx.configDir);
    if (!existsSync(file)) {
      ctx.log('No runner log yet.');
      return 1;
    }
    const text = readFileSync(file, 'utf8');
    ctx.log(text.trimEnd().split('\n').slice(-(lines ?? 50)).join('\n'));
    if (p.values.follow) await follow(file, Buffer.byteLength(text));
    return 0;
  }

  const entry = listRuns(ctx.configDir, card)[0];
  const name = entry && (step ? entry.logs[step - 1] : entry.logs.at(-1));
  if (!entry || !name) {
    ctx.log(`No logs for ${card} yet.`);
    return 1;
  }
  const file = join(entry.dir, name);
  const text = readFileSync(file, 'utf8');
  const shown = lines === undefined ? text : text.replace(/\n$/, '').split('\n').slice(-lines).join('\n') + '\n';
  process.stdout.write(shown.endsWith('\n') || !shown ? shown : shown + '\n');
  if (p.values.follow) {
    const newest = () => {
      if (step) return null;
      // A new run of the same card gets its own folder.
      const dir = listRuns(ctx.configDir, card)[0]?.dir ?? entry.dir;
      const all = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
      return all.length ? join(dir, all.at(-1)!) : null;
    };
    await follow(file, Buffer.byteLength(text), newest);
  }
  return 0;
});

const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

function removeWorktree(wt: string): void {
  const common = git(['-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repo = common.status === 0 ? common.stdout.trim().replace(/\/\.git\/?$/, '') : '';
  if (repo && git(['-C', repo, 'worktree', 'remove', '--force', wt]).status === 0) return;
  rmSync(wt, { recursive: true, force: true });
  if (repo) git(['-C', repo, 'worktree', 'prune']);
}

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

const clean = guard(async (args, ctx) => {
  const p = parse('clean', args, { older: { type: 'string' }, yes: { type: 'boolean' } }, ctx);
  if (typeof p === 'number') return p;
  const age = p.values.older ?? '14d';
  const ms = parseAge(age);
  if (ms === null) return usageError('clean', ctx, `${age} is not an age. Use a number of days or hours, like 14d or 36h.`);
  const cutoff = Date.now() - ms;
  const live = new Set(liveRuns(ctx.configDir).map((c) => c.card));
  const wtRoot = join(agentsDir(ctx.configDir), 'worktrees');
  const worktrees = (existsSync(wtRoot) ? readdirSync(wtRoot) : [])
    .filter((card) => !live.has(card))
    .filter((card) => {
      const record = listRuns(ctx.configDir, card)[0]?.record;
      const ended = record?.endedAt ? Date.parse(record.endedAt) : mtime(join(wtRoot, card));
      return ended < cutoff;
    })
    .map((card) => join(wtRoot, card));
  const old = listRuns(ctx.configDir).filter((e) => {
    if (e.record?.outcome === 'running' && live.has(e.card)) return false;
    return (e.record?.endedAt ? Date.parse(e.record.endedAt) : mtime(e.dir)) < cutoff;
  });
  if (!worktrees.length && !old.length) {
    ctx.log(`Nothing older than ${age}.`);
    return 0;
  }
  ctx.log(`Removes ${plural(worktrees.length, 'worktree')} and ${plural(old.length, 'run')} older than ${age}.`);
  if (!p.values.yes) {
    if (!process.stdin.isTTY) {
      ctx.log('Not removing without a terminal to confirm. Pass --yes to go ahead.');
      return 2;
    }
    if (!(await ctx.ui.confirm('Remove them?', false))) {
      ctx.log('Nothing removed.');
      return 0;
    }
  }
  for (const wt of worktrees) removeWorktree(wt);
  for (const e of old) {
    rmSync(e.dir, { recursive: true, force: true });
    const parent = join(e.dir, '..');
    if (existsSync(parent) && !readdirSync(parent).length) rmSync(parent, { recursive: true, force: true });
  }
  ctx.log(`Removed ${plural(worktrees.length, 'worktree')} and ${plural(old.length, 'run')}.`);
  return 0;
});

// Internal: the runner (launchd or systemd) runs this every minute, and it
// starts itself with --card or --schedule for each run, one per workspace.
const tickCmd: ToolCommand = async (args, ctx) => {
  const stamped = (l: string) => ctx.log(`${new Date().toISOString()} ${l}`);
  try {
    const { values } = parseArgs({ args, options: { card: { type: 'string' }, workflow: { type: 'string' }, schedule: { type: 'string' } }, strict: true });
    const config = readAgentsConfig(ctx.configDir);
    const rc = {
      configDir: ctx.configDir, config, trackers: trackersFor(ctx.configDir), log: stamped, selfCommand: ctx.selfCommand,
      notify: (e: RunEvent) => notifyRun(ctx.configDir, e, stamped),
      summary: (paused: boolean) => sendSummary(ctx.configDir, paused, stamped),
    };
    if (values.card || values.workflow) return await tick(rc, values.card?.toUpperCase(), { workflow: values.workflow, schedule: values.schedule, child: true });
    return await dispatch(rc, { reload: () => readAgentsConfig(ctx.configDir) });
  } catch (err) {
    stamped(`Could not run the check: ${(err as Error).message}`);
    return 1;
  }
};

export const controlCommands: Record<string, ToolCommand> = { status, start, stop, restart, pause, resume, run, cancel, retry, runs, show, logs, clean, tick: tickCmd };

function engineLogin(engine: string): Check {
  const [bin, args] = engine === 'codex' ? ['codex', ['login', 'status']] : ['claude', ['auth', 'status']];
  const r = spawnSync(bin!, args as string[], { encoding: 'utf8' });
  const name = 'engine login';
  if (r.error) return { name, status: 'fail', detail: `${bin} not installed` };
  let ok = r.status === 0;
  if (engine !== 'codex') {
    try {
      ok = JSON.parse(r.stdout).loggedIn === true;
    } catch {
      ok = false;
    }
  }
  return ok
    ? { name, status: 'ok', detail: `${bin} logged in` }
    : { name, status: 'fail', detail: `${bin} not logged in`, fix: engine === 'codex' ? 'codex login' : 'claude, then /login' };
}

export async function controlChecks(ctx: ToolContext): Promise<Check[]> {
  const checks: Check[] = [];
  const state = runnerState(ctx);
  checks.push(
    state === 'running'
      ? { name: 'agent runner', status: 'ok', detail: 'checking every minute' }
      : state === 'paused'
        ? { name: 'agent runner', status: 'warn', detail: 'paused', fix: 'vsf agents resume' }
        : { name: 'agent runner', status: 'warn', detail: 'not running', fix: 'vsf agents start' },
  );
  const service = runnerService();
  const installed = service.programArgs(ctx.home);
  if (installed) {
    const missing = installed.filter((a) => a.startsWith('/') && !existsSync(a));
    checks.push(
      missing.length
        ? { name: 'runner program', status: 'fail', detail: `runner points at a missing ${missing[0]}`, fix: 'vsf agents restart' }
        : { name: 'runner program', status: 'ok', detail: 'found' },
    );
  }
  const locks = [readCurrent(ctx.configDir), ...workspaceLocks(ctx.configDir)];
  if (locks.some((c) => c && !ours(c.pid))) checks.push({ name: 'stale lock', status: 'warn', detail: 'a stale lock from a run that died', fix: 'vsf agents cancel' });
  if (existsSync(logPath(ctx.configDir))) {
    const { count, last } = scanRunnerErrors(readLog(ctx.configDir), Date.now());
    checks.push(
      count
        ? { name: 'runner errors', status: 'warn', detail: `${plural(count, 'error')} in the last hour, last: ${last.slice(0, 120)}`, fix: 'vsf agents logs' }
        : { name: 'runner errors', status: 'ok', detail: 'no errors in the last hour' },
    );
  }
  checks.push(...service.checks());
  checks.push(engineLogin(readAgentsConfig(ctx.configDir).engine));
  return checks;
}
