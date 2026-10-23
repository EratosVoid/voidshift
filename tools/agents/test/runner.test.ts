import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cancelCard, nextJob, runCard, summarize, tick, type RunContext } from '../src/runner.ts';
import { DEFAULTS } from '../src/config.ts';
import type { Card } from '../src/linear.ts';
import type { Tracker } from '../src/tracker.ts';
type Linear = Tracker;
import { agentsDir } from '../src/config.ts';
import { lockPath, readPending, setPaused, writePending } from '../src/state.ts';

const card = (labels: string[], teamKey = 'ENG'): Card => ({ id: '1', identifier: 'ENG-1', title: 'T', url: 'u', branchName: 'b', teamId: 't', teamKey, labels });

function setup(linear: Partial<Linear>, workflows: RunContext['config']['workflows'] = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-runner-'));
  mkdirSync(agentsDir(configDir), { recursive: true });
  const logs: string[] = [];
  // The fake tracker stays reachable as rc.linear so tests can swap methods.
  const rc = {
    configDir,
    config: { ...structuredClone(DEFAULTS), workflows },
    linear: linear as Linear,
    trackers: () => rc.linear,
    log: (l: string) => void logs.push(l),
    selfCommand: ['vsf'],
  } as RunContext & { linear: Linear };
  return { rc, configDir, logs };
}

const wf = (label: string) => ({ triggers: [{ source: 'linear' as const, team: 'ENG', label }], steps: ['vs-qa' as const], maxRounds: 2, project: 'p' });

test('summarize keeps the first three non-empty lines, cut to 300 chars', () => {
  assert.equal(summarize('\n one \n\n two\nthree\nfour'), 'one two three');
  assert.equal(summarize('x'.repeat(400)).length, 300);
  assert.equal(summarize(''), '');
});

test('a paused tick returns 0 and never calls Linear', async () => {
  const { rc, configDir } = setup(new Proxy({}, { get: () => () => assert.fail('Linear was called') }) as Partial<Linear>);
  setPaused(configDir, true);
  assert.equal(await tick(rc), 0);
  assert.equal(existsSync(lockPath(configDir)), false);
});

test('pending writes are flushed and pending.json removed', async () => {
  const calls: string[] = [];
  const { rc, configDir } = setup({
    card: async () => card(['vs-working', 'keep']),
    comment: async (_c, body) => void calls.push(`comment:${body}`),
    setLabels: async (_c, next) => void calls.push(`labels:${next.join(',')}`),
    myCardsWithLabel: async () => [],
  });
  writePending(configDir, [{ card: 'ENG-1', comment: 'hi', drop: ['vs-working'], add: ['parked'] }]);
  setPaused(configDir, true);
  await tick(rc);
  assert.deepEqual(calls, ['comment:hi', 'labels:keep,parked']);
  assert.equal(existsSync(join(agentsDir(configDir), 'pending.json')), false);
});

test('pending writes are kept when Linear throws', async () => {
  const { rc, configDir } = setup({ card: async () => { throw new Error('down'); } });
  writePending(configDir, [{ card: 'ENG-1', comment: 'hi', drop: [], add: [] }]);
  setPaused(configDir, true);
  assert.equal(await tick(rc), 0);
  assert.equal(readPending(configDir).length, 1);
});

test('nextJob with a workflow name only matches that workflow', async () => {
  const { rc } = setup({ myCardsWithLabel: async () => [card(['a', 'b'])] }, { one: wf('a'), two: wf('b') });
  assert.equal((await nextJob(rc))?.workflow, 'one');
  assert.equal((await nextJob(rc, undefined, 'two'))?.workflow, 'two');
  assert.equal(await nextJob(rc, undefined, 'missing'), null);
});

test('a stale lock does not block tick', async () => {
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
  writeFileSync(lockPath(configDir), JSON.stringify({ pid: 999999999 }));
  assert.equal(await tick(rc), 0);
  assert.equal(existsSync(lockPath(configDir)), false);
});

// A stand-in runner: its command line contains " agents tick".
function fakeRunner() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'agents', 'tick'], { stdio: 'ignore' });
}

test('a live runner lock makes tick return 0 and leaves the lock alone', async () => {
  const child = fakeRunner();
  try {
    const { rc, configDir } = setup(new Proxy({}, { get: () => () => assert.fail('Linear was called') }) as Partial<Linear>);
    writeFileSync(lockPath(configDir), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    assert.equal(await tick(rc), 0);
    assert.equal(existsSync(lockPath(configDir)), true);
  } finally {
    child.kill();
  }
});

test('a live pid that is not our runner is a stale lock', async () => {
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
  writeFileSync(lockPath(configDir), JSON.stringify({ pid: process.ppid }));
  assert.equal(await tick(rc), 0);
  assert.equal(existsSync(lockPath(configDir)), false);
});

test('a lock from before the boot is stale', async () => {
  const child = fakeRunner();
  try {
    const { rc, configDir } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
    writeFileSync(lockPath(configDir), JSON.stringify({ pid: child.pid, startedAt: '2000-01-01T00:00:00.000Z' }));
    assert.equal(await tick(rc), 0);
    assert.equal(existsSync(lockPath(configDir)), false);
  } finally {
    child.kill();
  }
});

test('a busy runner with a pinned card says so and returns 1', async () => {
  const child = fakeRunner();
  try {
    const { rc, configDir, logs } = setup(new Proxy({}, { get: () => () => assert.fail('Linear was called') }) as Partial<Linear>);
    writeFileSync(lockPath(configDir), JSON.stringify({ pid: child.pid, card: 'ENG-9', startedAt: new Date().toISOString() }));
    assert.equal(await tick(rc, 'ENG-1'), 1);
    assert.deepEqual(logs, ['The runner is busy with ENG-9. Try again when it finishes.']);
  } finally {
    child.kill();
  }
});

test('a pinned card matches by team without the label; an unpinned one needs it', async () => {
  const { rc } = setup({ card: async () => card(['vs-parked']), myCardsWithLabel: async () => [card(['other'])] }, { one: wf('a') });
  assert.equal((await nextJob(rc, 'ENG-1'))?.workflow, 'one');
  assert.equal(await nextJob(rc), null);
  rc.linear.card = async () => card([], 'OPS');
  assert.equal(await nextJob(rc, 'ENG-1'), null);
});

test('a bad --from returns 2 and writes nothing to Linear', async () => {
  const { rc, logs } = setup({
    card: async () => card(['a']),
    comment: async () => assert.fail('commented'),
    setLabels: async () => assert.fail('set labels'),
    comments: async () => assert.fail('read comments'),
  }, { one: wf('a') });
  rc.config.projects.p = { path: '/nonexistent' };
  assert.equal(await tick(rc, 'ENG-1', { from: 'vs-dev' }), 2);
  assert.deepEqual(logs, ['Workflow one has no Dev step.']);
});

test('park does not repeat the comment when only setLabels failed', async () => {
  const { rc, configDir } = setup({
    comments: async () => [],
    comment: async () => {},
    setLabels: async () => { throw new Error('down'); },
  });
  rc.config.projects.p = { path: '/nonexistent' };
  const outcome = await runCard(card(['a']), wf('a').triggers[0]!, 'one', wf('a'), rc.config.projects.p, rc);
  assert.equal(outcome, 'parked');
  const pending = readPending(configDir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.comment, '');
});

test('runCard writes the lock with the card before calling Linear', async () => {
  let seen: unknown;
  const { rc, configDir } = setup({
    comments: async () => { seen = JSON.parse(readFileSync(lockPath(configDir), 'utf8')); throw new Error('stop'); },
    comment: async () => {},
    setLabels: async () => {},
  });
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  mkdirSync(join(repo, '.git'));
  rc.config.projects.p = { path: repo };
  await runCard(card(['a']), wf('a').triggers[0]!, 'one', wf('a'), rc.config.projects.p, rc);
  assert.equal((seen as { card: string }).card, 'ENG-1');
  assert.equal((seen as { step: string }).step, 'Starting');
});

test('cancelCard drops the working label and comments', async () => {
  const calls: string[] = [];
  const { configDir } = setup({});
  const linear = { card: async () => card(['vs-working', 'keep']), setLabels: async (_c: Card, n: string[]) => void calls.push(`labels:${n}`), comment: async (_c: Card, b: string) => void calls.push(b) } as unknown as Linear;
  assert.equal(await cancelCard(linear, configDir, 'ENG-1', 'go'), true);
  assert.deepEqual(calls, ['labels:keep', '**Cancelled.** Add `go` again to restart.']);
});

test('cancelCard queues a pending entry when Linear fails', async () => {
  const { configDir } = setup({});
  const linear = { card: async () => { throw new Error('down'); } } as unknown as Linear;
  assert.equal(await cancelCard(linear, configDir, 'ENG-1', 'go'), false);
  assert.deepEqual(readPending(configDir), [{ card: 'ENG-1', comment: '**Cancelled.** Add `go` again to restart.', drop: [], add: [], dropStatus: true, source: 'linear' }]);
});

test('an unexpected error is logged as one line and returns 1', async () => {
  const { rc, logs } = setup({ myCardsWithLabel: async () => [card(['a'])] }, { one: { ...wf('a'), project: 'p' } });
  rc.config.projects.p = { path: '/nonexistent' };
  rc.config.workflows.one!.steps = ['vs-qa'];
  rc.linear.comments = async () => { throw new Error('boom'); };
  rc.linear.setLabels = async () => { throw new Error('boom'); };
  rc.linear.comment = async () => { throw new Error('boom'); };
  const code = await tick(rc);
  assert.equal(code, 1);
  assert.ok(logs.every((l) => !l.includes('\n    at ')));
});
