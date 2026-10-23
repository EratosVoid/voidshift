import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelCurrent, countRounds, isInterrupted, formatRunLine, parseAge, parsePlistArgs, pickCancel, scanRunnerErrors, trackerWarnings, workingLine, workspaceLines } from '../src/control.ts';
import type { Tracker, Trackers } from '../src/tracker.ts';
import { lockPath, workspaceLockPath, writeCurrent, writeWorkspace, type RunEntry } from '../src/state.ts';
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
  assert.match(formatRunLine(e), /interrupted/);
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
