import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelCurrent, countRounds, isInterrupted, formatRunLine, jobSummaries, shownOutcome, parseAge, parsePlistArgs, pickCancel, scanRunnerErrors, trackerWarnings, workingLine, workspaceLines } from '../src/control.ts';
import type { Tracker, Trackers } from '../src/tracker.ts';
import { readAgentsConfig, writeAgentsConfig, type Workflow } from '../src/config.ts';
import { lockPath, readWindow, workspaceLockPath, writeCurrent, writeWindow, writeWorkspace, type RunEntry } from '../src/state.ts';
import { controlCommands } from '../src/control.ts';
import { windowLine } from '../src/usage.ts';
import type { ToolContext } from '../src/types.ts';

test('parseAge reads days and hours', () => {
  assert.equal(parseAge('14d'), 14 * 86_400_000);
  assert.equal(parseAge('36h'), 36 * 3_600_000);
  for (const bad of ['', '14', 'd', '0d', '2w', '-1d', '1.5d']) assert.equal(parseAge(bad), null);
});

const record = (over = {}) => ({
  card: 'ENG-12',
  title: 'Fix login',
  workflow: 'tether-relay-build',
  trigger: 'vs-plan',
  steps: [
    { step: 'vs-dev' as const, label: 'Dev', startedAt: '2026-10-20T10:00:00.000Z', result: 'done' },
    { step: 'vs-qa' as const, label: 'QA', startedAt: '2026-10-20T10:10:00.000Z', result: 'FIX' },
    { step: 'vs-dev' as const, label: 'Dev', startedAt: '2026-10-20T10:12:00.000Z', result: 'done' },
    { step: 'vs-qa' as const, label: 'QA', startedAt: '2026-10-20T10:15:00.000Z', result: 'SHIP' },
  ],
  outcome: 'verified' as const,
  startedAt: '2026-10-20T10:00:00.000Z',
  endedAt: '2026-10-20T10:18:00.000Z',
  ...over,
});

test('countRounds counts rounds that had a FIX', () => {
  assert.equal(countRounds(record().steps), 1);
  assert.equal(countRounds([]), 0);
  const r = (...v: string[]) => v.map((result) => ({ result }));
  // two checks in one round, both FIX: still one round
  assert.equal(countRounds(r('done', 'FIX', 'FIX', 'done', 'SHIP')), 1);
  // a round with only SHIP/SKIP does not count
  assert.equal(countRounds(r('SHIP', 'SKIP')), 0);
  assert.equal(countRounds(r('FIX', 'done', 'FIX', 'done', 'SHIP')), 2);
});

test('isInterrupted flags running records that are not live', () => {
  const e: RunEntry = { card: 'ENG-12', stamp: 'x', dir: '/x', record: record({ outcome: 'running' }), logs: [] };
  assert.equal(isInterrupted(e, []), true);
  assert.equal(isInterrupted(e, [{ pid: 1, card: 'ENG-12', runDir: '/x' }]), false);
  assert.equal(isInterrupted(e, [{ pid: 1, card: 'ENG-3', runDir: '/y', workspace: 'a' }, { pid: 2, card: 'ENG-12', runDir: '/x', workspace: 'b' }]), false, 'a second live run');
  assert.match(formatRunLine(e), /failed/);
  assert.equal(shownOutcome(e, []), 'failed');
  assert.equal(shownOutcome(e, [{ pid: 1, card: 'ENG-12', runDir: '/x' }]), 'running');
});

test('a stale lock is cleared without any signal and the run is marked cancelled', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-ctl-'));
  const runDir = join(configDir, 'agents', 'runs', 'ENG-12', '2026-10-20T10-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(record({ outcome: 'running', endedAt: undefined })));
  writeCurrent(configDir, { pid: 999999, card: 'ENG-12', workflow: 'x', runDir });
  const signals: string[] = [];
  const cancelled: string[][] = [];
  const logs: string[] = [];
  const ctx = { configDir, log: (l: string) => logs.push(l) } as unknown as ToolContext;
  await cancelCurrent(ctx, { pid: 999999, card: 'ENG-12', workflow: 'x', runDir }, {
    ours: () => false,
    kill: (pid, sig) => signals.push(`${pid} ${sig}`),
    sleep: async () => {},
    cancelCard: async (card, label) => (cancelled.push([card, label]), true),
  });
  assert.deepEqual(signals, []);
  assert.deepEqual(cancelled, [['ENG-12', "the workflow's label"]]);
  assert.equal(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).outcome, 'cancelled');
  assert.deepEqual(logs, ['Cleared a stale lock and cancelled ENG-12.']);
  assert.throws(() => readFileSync(lockPath(configDir)));
});

test('a stale workspace lock is cleared from the locks folder', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-ctl-'));
  writeWorkspace(configDir, 'solvia', { pid: 999999 });
  const ctx = { configDir, log: () => {} } as unknown as ToolContext;
  const deps = { ours: () => false, kill: () => {}, sleep: async () => {}, cancelCard: async () => true };
  await cancelCurrent(ctx, { pid: 999999, workspace: 'solvia' }, deps);
  assert.throws(() => readFileSync(workspaceLockPath(configDir, 'solvia')));
});

test('cancel without a card refuses when more than one run is live', () => {
  const a = { pid: 1, card: 'DS06-1', workspace: 'solvia' };
  const b = { pid: 2, card: 'ORG-9', workspace: 'devvoid' };
  assert.equal(pickCancel([a, b], null), 'More than one card is running: DS06-1 in solvia, ORG-9 in devvoid. Name one: vsf agents cancel CARD.');
  assert.equal(pickCancel([a, b], null, 'ORG-9'), b);
  assert.equal(pickCancel([a], null), a);
  assert.deepEqual(pickCancel([], { pid: 3 }), { pid: 3 }, 'a check in progress');
  assert.equal(pickCancel([], null), 'Nothing is running.');
  assert.equal(pickCancel([a], null, 'ENG-1'), 'ENG-1 is not running. Running: DS06-1 in solvia.');
});

test('status prints a line per workspace', () => {
  const running = [{ pid: 1, card: 'DS06-1', workflow: 'build', step: 'Dev', round: 1, workspace: 'solvia', elapsedMinutes: 4 }];
  assert.deepEqual(workspaceLines(['solvia', 'devvoid'], running), ['  solvia: Working on DS06-1 (build, Dev, round 1, 4m).', '  devvoid: idle.']);
});

test('a live runner gets SIGTERM, then SIGKILL, and no card cleanup from us', async () => {
  const ctx = { configDir: mkdtempSync(join(tmpdir(), 'vsf-ctl-')), log: () => {} } as unknown as ToolContext;
  const signals: string[] = [];
  let cleaned = 0;
  await cancelCurrent(ctx, { pid: 42, card: 'ENG-1' }, {
    ours: () => true,
    kill: (pid, sig) => signals.push(`${pid} ${sig}`),
    sleep: async () => {},
    cancelCard: async () => (cleaned++, true),
  });
  assert.deepEqual(signals, ['42 SIGTERM', '42 SIGKILL']);
  assert.equal(cleaned, 0);
});

test('formatRunLine shows a finished run', () => {
  const e: RunEntry = { card: 'ENG-12', stamp: 'x', dir: '/x', record: record(), logs: [] };
  const line = formatRunLine(e);
  assert.match(line, /^ENG-12  Oct 20 \d\d:\d\d  tether-relay-build  Dev → QA → Dev → QA  verified  1 round  18m$/);
});

test('formatRunLine shows elapsed time for a running run and skips zero rounds', () => {
  const r = record({ outcome: 'running', endedAt: undefined, steps: [] });
  const e: RunEntry = { card: 'ENG-12', stamp: 'x', dir: '/x', record: r, logs: [] };
  assert.match(formatRunLine(e, Date.parse('2026-10-20T11:05:00.000Z'), [{ pid: 1, card: 'ENG-12', runDir: '/x' }]), /running  1h 5m$/);
});

test('formatRunLine handles runs without a record', () => {
  const e: RunEntry = { card: 'ENG-3', stamp: '2026-10-20T14-03-00-123Z', dir: '/x', logs: ['a.log', 'b.log'] };
  assert.match(formatRunLine(e), /^ENG-3  Oct 20 \d\d:\d\d  older run, logs only \(2 logs\)$/);
});

test('scanRunnerErrors counts only recent error lines', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  const text = [
    '2026-10-20T10:00:00.000Z Could not reach Linear',
    '2026-10-20T11:30:00.000Z Nothing to do.',
    '2026-10-20T11:40:00.000Z Could not reach Linear (ENOTFOUND)',
    '2026-10-20T11:50:00.000Z Something went wrong with ENG-1',
    'Error without a timestamp',
  ].join('\n');
  assert.deepEqual(scanRunnerErrors(text, now), { count: 2, last: '2026-10-20T11:50:00.000Z Something went wrong with ENG-1' });
  assert.deepEqual(scanRunnerErrors('', now), { count: 0, last: '' });
});

test('parsePlistArgs reads ProgramArguments only', () => {
  const plist = `<dict>
  <key>Label</key>
  <string>org.devvoid.x</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/a/b &amp; c/cli.ts</string>
    <string>agents</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/bin</string></dict>
</dict>`;
  assert.deepEqual(parsePlistArgs(plist), ['/usr/local/bin/node', '/a/b & c/cli.ts', 'agents']);
  assert.deepEqual(parsePlistArgs('<dict></dict>'), []);
});

test('status shows the round the lock holds, as the card label does', () => {
  const current = { pid: 1, card: 'ORG-1', workflow: 'build', step: 'Dev', round: 2, elapsedMinutes: 3 };
  assert.equal(workingLine(current), ' Working on ORG-1 (build, Dev, round 2, 3m).');
  assert.equal(workingLine({ ...current, step: 'Starting', round: 0 }), ' Working on ORG-1 (build, Starting, 3m).');
});

test('a missing tracker key is a warning naming the key', async () => {
  const missing = 'No VoidTrack API key. Run vsf agents key --voidtrack';
  const trackers: Trackers = (kind) => ({
    viewer: async () => {
      if (kind === 'voidtrack') throw new Error(missing);
      return { id: 'u1', name: 'Me' };
    },
  }) as unknown as Tracker;
  assert.deepEqual(await trackerWarnings(['linear', 'voidtrack'], trackers), [{ kind: 'voidtrack', message: missing }]);
});

test('status prints the window line, and the held line once it reaches pauseAt', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-ctl-'));
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  writeWindow(configDir, { checkedAt: new Date().toISOString(), utilization: 62, resetsAt });
  assert.match(windowLine(readWindow(configDir), 90), /^Window: 5 hour at 62%, resets \d\d:\d\d\.$/);
  writeWindow(configDir, { checkedAt: new Date().toISOString(), utilization: 91, resetsAt });
  assert.match(windowLine(readWindow(configDir), 90), /^Window: held at 91% until \d\d:\d\d, running cards finish\.$/);
});

test('show lists tokens and cost per step and a total', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-ctl-'));
  const runDir = join(configDir, 'agents', 'runs', 'ENG-12', '2026-10-20T10-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  const steps = [{ step: 'vs-dev', label: 'Dev', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:05:00.000Z', result: 'done', usage: { input: 1200, output: 300, costUsd: 0.5, model: 'opus' } }];
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(record({ steps, usage: { input: 1200, output: 300, costUsd: 0.5, models: ['opus'] } })));
  const logs: string[] = [];
  const ctx = { configDir, log: (l: string) => logs.push(l) } as unknown as ToolContext;
  assert.equal(await controlCommands.show!(['ENG-12'], ctx), 0);
  assert.ok(logs.some((l) => /^  Dev .* 1\.2k in, 300 out, \$0\.50 est\./.test(l)), logs.join('\n'));
  assert.ok(logs.includes('Usage: 1.2k in, 300 out, $0.50 est., opus'), logs.join('\n'));
});

test('a stale run shows its duration up to the last sign of life', () => {
  const steps = [{ step: 'vs-dev', label: 'Dev', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:07:00.000Z' }];
  const e: RunEntry = { card: 'ENG-12', stamp: 'x', dir: '/x', record: record({ outcome: 'running', endedAt: undefined, steps }), logs: [] };
  assert.match(formatRunLine(e, Date.parse('2026-10-21T10:00:00.000Z'), []), /failed  7m$/);
});

// Writes a run folder with a record.
const writeRunFixture = (configDir: string, card: string, stamp: string, over = {}) => {
  const runDir = join(configDir, 'agents', 'runs', card, stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(record({ card, ...over })));
};

const nightly = { triggers: [{ source: 'cron', schedule: '0 5 * * *', task: 'Scout' }], steps: ['vs-dev'], maxRounds: 1, project: 'p' } as unknown as Workflow;

const setup = () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-ctl-'));
  writeAgentsConfig(configDir, { ...readAgentsConfig(configDir), workflows: { nightly } });
  const logs: string[] = [];
  const ctx = { configDir, log: (l: string) => logs.push(l) } as unknown as ToolContext;
  return { configDir, logs, ctx };
};

const nowIso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const cronRun = (outcome: string, minutesAgo: number, over = {}) => {
  const at = nowIso(minutesAgo);
  return { workflow: 'nightly', trigger: '0 5 * * *', source: 'cron', outcome, startedAt: at, endedAt: at, ...over };
};

test('status aggregates jobs with handed counts and the last failure', async () => {
  const { configDir, logs, ctx } = setup();
  const stamp = (n: number) => `2026-10-2${n}T10-00-00-000Z`;
  writeRunFixture(configDir, 'TETHERQASCOUT-1', stamp(1), cronRun('done', 30, { steps: [{ step: 's', label: 'Scout', startedAt: nowIso(31), handoffs: ['ENG-1', 'ENG-2'] }] }));
  writeRunFixture(configDir, 'TETHERQASCOUT-2', stamp(2), cronRun('failed', 10, { reason: 'Boom.', steps: [{ step: 's', label: 'Scout', startedAt: nowIso(11), summary: 'hi', handoffs: ['ENG-3'] }] }));
  const [job] = jobSummaries(readAgentsConfig(configDir), (await import('../src/state.ts')).listRuns(configDir), []);
  assert.equal(job!.workflow, 'nightly');
  assert.equal(job!.last!.outcome, 'failed');
  assert.equal(job!.last!.summary, 'hi');
  assert.ok(job!.lastOkAt);
  assert.deepEqual(job!.today, { runs: 2, failed: 1, handed: 3 });
  assert.equal(await controlCommands.status!([], ctx), 0);
  assert.ok(logs.some((l) => /^Job nightly \(cron 0 5 \* \* \*\): last failed \d\d:\d\d \(Boom\), 2 runs today, 1 failed, 3 handed\.$/.test(l)), logs.join('\n'));
});

test('status lists failed cards from their latest run only, and ignores cron runs', async () => {
  const { configDir, logs, ctx } = setup();
  writeRunFixture(configDir, 'ENG-1', '2026-10-20T10-00-00-000Z', { outcome: 'failed', reason: 'Old.' });
  writeRunFixture(configDir, 'ENG-1', '2026-10-21T10-00-00-000Z', { outcome: 'verified' });
  writeRunFixture(configDir, 'ENG-2', '2026-10-21T10-00-00-000Z', { outcome: 'failed', reason: 'Bad build.' });
  writeRunFixture(configDir, 'ENG-3', '2026-10-21T10-00-00-000Z', { outcome: 'running', endedAt: undefined });
  writeRunFixture(configDir, 'CRON-1', '2026-10-21T10-00-00-000Z', cronRun('failed', 5));
  assert.equal(await controlCommands.status!(['--json'], ctx), 0);
  const out = JSON.parse(logs.join('\n'));
  assert.deepEqual(out.failed.map((f: { card: string }) => f.card).sort(), ['ENG-2', 'ENG-3']);
  assert.deepEqual(out.interrupted, []);
  assert.equal(out.failed.find((f: { card: string }) => f.card === 'ENG-2').reason, 'Bad build.');
});

test('runs hides scheduled runs unless --jobs is given', async () => {
  const { configDir, logs, ctx } = setup();
  writeRunFixture(configDir, 'ENG-1', '2026-10-21T10-00-00-000Z', {});
  writeRunFixture(configDir, 'CRON-1', '2026-10-21T11-00-00-000Z', cronRun('done', 5));
  await controlCommands.runs!([], ctx);
  assert.deepEqual(logs.map((l) => l.split('  ')[0]), ['ENG-1']);
  logs.length = 0;
  await controlCommands.runs!(['--jobs'], ctx);
  assert.deepEqual(logs.map((l) => l.split('  ')[0]), ['CRON-1']);
});

test('retry refuses a scheduled run', async () => {
  const { configDir, logs, ctx } = setup();
  writeRunFixture(configDir, 'CRON-1', '2026-10-21T11-00-00-000Z', cronRun('failed', 5));
  assert.equal(await controlCommands.retry!(['CRON-1'], ctx), 1);
  assert.deepEqual(logs, ['CRON-1 is a scheduled run. vsf agents run --workflow nightly fires it now.']);
});
