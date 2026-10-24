import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cancelCard, dispatch, findJobs, nextJob, runCard, stepComment, summarize, tick, type ChildRun, type RunContext } from '../src/runner.ts';
import { DEFAULTS } from '../src/config.ts';
import type { Card } from '../src/linear.ts';
import type { Tracker } from '../src/tracker.ts';
type Linear = Tracker;
import { agentsDir } from '../src/config.ts';
import { lockPath, readCronState, readPending, setPaused, workspaceLockPath, writeCronState, writePending, writeWindow } from '../src/state.ts';

const card = (labels: string[], teamKey = 'ENG', identifier = 'ENG-1', projectName?: string): Card => ({ id: '1', identifier, title: 'T', url: 'u', branchName: 'b', teamId: 't', teamKey, labels, projectName });

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

// Child runs the dispatcher starts: each records its arguments and exits
// when the test lets it, or at once.
function fakeStarts(events: string[], hold = false) {
  const children: (EventEmitter & ChildRun)[] = [];
  const start = (args: string[]) => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: () => true });
    const card = args[args.indexOf('--card') + 1] ?? args.join(' ');
    events.push(`start ${card}`);
    children.push(child);
    const exit = () => {
      events.push(`exit ${card}`);
      child.exitCode = 0;
      child.emit('exit');
    };
    if (!hold) setImmediate(exit);
    else (child as unknown as { exit: () => void }).exit = exit;
    return child;
  };
  return { start, children, waitMs: 60_000, window: async () => {} };
}

// Two workspaces, wa and wb, with a project in each that claims a tracker project.
function twoWorkspaces(rc: RunContext, root: string) {
  rc.config.workspaces = { wa: { root }, wb: { root } };
  rc.config.projects = { a: { path: '/a', workspace: 'wa', match: ['Alpha'] }, b: { path: '/b', workspace: 'wb', match: ['Beta'] } };
}

test('a paused dispatcher returns 0 and never calls Linear', async () => {
  const { rc, configDir } = setup(new Proxy({}, { get: () => () => assert.fail('Linear was called') }) as Partial<Linear>);
  setPaused(configDir, true);
  assert.equal(await dispatch(rc, fakeStarts([])), 0);
  assert.equal(existsSync(lockPath(configDir)), false);
});

test('cards in two workspaces start side by side in one pass', async () => {
  const events: string[] = [];
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [card(['a'], 'ENG', 'ENG-1', 'Alpha Corp'), card(['a'], 'ENG', 'ENG-2', 'Beta')] }, { one: wf('a') });
  twoWorkspaces(rc, configDir);
  assert.equal(await dispatch(rc, fakeStarts(events)), 0);
  assert.deepEqual(events.slice(0, 2), ['start ENG-1', 'start ENG-2']);
  assert.equal(events.length, 4);
  assert.equal(existsSync(lockPath(configDir)), false);
});

test('two cards in one workspace run one after the other', async () => {
  const events: string[] = [];
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [card(['a'], 'ENG', 'ENG-1', 'Alpha'), card(['a'], 'ENG', 'ENG-2', 'Alpha')] }, { one: wf('a') });
  twoWorkspaces(rc, configDir);
  assert.equal(await dispatch(rc, fakeStarts(events)), 0);
  assert.deepEqual(events, ['start ENG-1', 'exit ENG-1', 'start ENG-2', 'exit ENG-2']);
});

test('a child run gets the card and workflow it is for', async () => {
  const { rc } = setup({ myCardsWithLabel: async () => [card(['a'])] }, { one: wf('a') });
  rc.config.projects.p = { path: '/p' };
  const seen: string[][] = [];
  const starts = fakeStarts([]);
  await dispatch(rc, { ...starts, start: (args) => (seen.push(args), starts.start(args)) });
  assert.deepEqual(seen, [['--card', 'ENG-1', '--workflow', 'one']]);
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

test('a stale lock does not block the dispatcher', async () => {
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
  writeFileSync(lockPath(configDir), JSON.stringify({ pid: 999999999 }));
  assert.equal(await dispatch(rc, fakeStarts([])), 0);
  assert.equal(existsSync(lockPath(configDir)), false);
});

// A stand-in runner: its command line contains " agents tick".
function fakeRunner() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'agents', 'tick'], { stdio: 'ignore' });
}

test('a live dispatcher lock makes another return 0 and leaves the lock alone', async () => {
  const child = fakeRunner();
  try {
    const { rc, configDir } = setup(new Proxy({}, { get: () => () => assert.fail('Linear was called') }) as Partial<Linear>);
    writeFileSync(lockPath(configDir), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    assert.equal(await dispatch(rc, fakeStarts([])), 0);
    assert.equal(existsSync(lockPath(configDir)), true);
  } finally {
    child.kill();
  }
});

test('a live pid that is not our runner is a stale lock', async () => {
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
  writeFileSync(lockPath(configDir), JSON.stringify({ pid: process.ppid }));
  assert.equal(await dispatch(rc, fakeStarts([])), 0);
  assert.equal(existsSync(lockPath(configDir)), false);
});

test('a lock from before the boot is stale', async () => {
  const child = fakeRunner();
  try {
    const { rc, configDir } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
    writeFileSync(lockPath(configDir), JSON.stringify({ pid: child.pid, startedAt: '2000-01-01T00:00:00.000Z' }));
    assert.equal(await dispatch(rc, fakeStarts([])), 0);
    assert.equal(existsSync(lockPath(configDir)), false);
  } finally {
    child.kill();
  }
});

// A workspace lock held by a live runner.
function holdWorkspace(configDir: string, workspace: string, pid: number, cardId = 'ENG-9') {
  mkdirSync(join(agentsDir(configDir), 'locks'), { recursive: true });
  writeFileSync(workspaceLockPath(configDir, workspace), JSON.stringify({ pid, card: cardId, workspace, startedAt: new Date().toISOString() }));
}

test('a busy workspace turns a pinned card away but lets another workspace run', async () => {
  const child = fakeRunner();
  try {
    const events: string[] = [];
    const cards = [card(['a'], 'ENG', 'ENG-1', 'Alpha'), card(['a'], 'ENG', 'ENG-2', 'Beta')];
    const { rc, configDir, logs } = setup({ card: async (id) => cards.find((c) => c.identifier === id)!, myCardsWithLabel: async () => cards }, { one: wf('a') });
    twoWorkspaces(rc, configDir);
    holdWorkspace(configDir, 'wa', child.pid!);
    assert.equal(await tick(rc, 'ENG-1'), 1);
    assert.deepEqual(logs, ['Workspace wa is busy with ENG-9. Try again when it finishes.']);
    assert.equal(await dispatch(rc, fakeStarts(events)), 0);
    assert.deepEqual(events, ['start ENG-2', 'exit ENG-2']);
    assert.equal(JSON.parse(readFileSync(workspaceLockPath(configDir, 'wa'), 'utf8')).card, 'ENG-9', 'the held lock is left alone');
  } finally {
    child.kill();
  }
});

test('a schedule whose workspace is busy waits and is not marked as fired', async () => {
  const child = fakeRunner();
  try {
    const { rc, configDir } = setup({}, { nightly: { ...wf('a'), triggers: [{ source: 'cron', schedule: '* * * * *', task: 'Tidy' }] } });
    rc.config.projects.p = { path: '/p' };
    const last = new Date(Date.now() - 5 * 60_000).toISOString();
    writeCronState(configDir, { 'nightly * * * * *': last });
    holdWorkspace(configDir, 'default', child.pid!);
    assert.deepEqual(await findJobs(rc, { busy: new Set(['default']) }), []);
    assert.equal(readCronState(configDir)['nightly * * * * *'], last);
    assert.equal((await findJobs(rc))[0]?.workflow, 'nightly');
    assert.notEqual(readCronState(configDir)['nightly * * * * *'], last);
  } finally {
    child.kill();
  }
});

test('a run for one schedule takes that schedule, not a labelled card in the same workflow', async () => {
  const { rc } = setup({ myCardsWithLabel: async () => [card(['a'])] }, { mixed: { ...wf('a'), triggers: [{ source: 'linear', team: 'ENG', label: 'a' }, { source: 'cron', schedule: '* * * * *', task: 'Tidy' }] } });
  rc.config.projects.p = { path: '/p' };
  assert.equal((await findJobs(rc, { workflow: 'mixed' }))[0]?.card.identifier, 'ENG-1');
  const jobs = await findJobs(rc, { workflow: 'mixed', schedule: '* * * * *', force: true });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.trigger.source, 'cron');
});

test('a card matched by its tracker project runs in that project, ahead of the workflow default', async () => {
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [card(['a'], 'ENG', 'ENG-1', 'Beta Ltd')] }, { one: { ...wf('a'), project: 'a' } });
  twoWorkspaces(rc, configDir);
  assert.equal((await nextJob(rc))?.workspace, 'wb');
  rc.linear.myCardsWithLabel = async () => [card(['a'], 'ENG', 'ENG-1', 'Gamma')];
  assert.equal((await nextJob(rc))?.workspace, 'wa', 'no match: the workflow project');
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

test('runCard writes the workspace lock with the card before calling Linear', async () => {
  let seen: unknown;
  const { rc, configDir } = setup({
    comments: async () => { seen = JSON.parse(readFileSync(workspaceLockPath(configDir, 'default'), 'utf8')); throw new Error('stop'); },
    comment: async () => {},
    setLabels: async () => {},
  });
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  mkdirSync(join(repo, '.git'));
  rc.config.projects.p = { path: repo };
  await runCard(card(['a']), wf('a').triggers[0]!, 'one', wf('a'), rc.config.projects.p, rc);
  assert.equal((seen as { card: string }).card, 'ENG-1');
  assert.equal((seen as { step: string }).step, 'Starting');
  assert.equal((seen as { workspace: string }).workspace, 'default');
});

test('cancelCard drops the working label and comments', async () => {
  const calls: string[] = [];
  const { configDir } = setup({});
  const linear = { card: async () => card(['vs-working', 'keep']), setLabels: async (_c: Card, n: string[]) => void calls.push(`labels:${n}`), comment: async (_c: Card, b: string) => void calls.push(b) } as unknown as Linear;
  assert.equal(await cancelCard(linear, configDir, 'ENG-1', 'go'), true);
  assert.deepEqual(calls, ['labels:keep', '**Cancelled.** Add `go` again to restart.']);
});

test('cancelCard drops a custom step label it is given', async () => {
  const calls: string[] = [];
  const { configDir } = setup({});
  const linear = { card: async () => card(['vs-editor', 'keep']), setLabels: async (_c: Card, n: string[]) => void calls.push(`labels:${n}`), comment: async () => {} } as unknown as Linear;
  assert.equal(await cancelCard(linear, configDir, 'ENG-1', 'go', 'linear', new Set(['vs-editor'])), true);
  assert.deepEqual(calls, ['labels:keep']);
});

test('stepComment heads with label, outcome, time and usage', () => {
  assert.equal(stepComment({ label: 'Editor', outcome: 'done', ms: 20_000, output: '  The brief.\n' }), '**Editor**: done · <1m\n\nThe brief.');
  assert.equal(
    stepComment({ label: 'Editor', outcome: 'SHIP', ms: 3 * 60_000, usage: { input: 12_300, output: 4_100, costUsd: 0.42 }, output: 'ok' }),
    '**Editor**: SHIP · 3m · 12.3k in, 4.1k out, $0.42 est.\n\nok',
  );
  assert.equal(stepComment({ label: 'Merge', outcome: 'done', ms: 0, output: '', command: true }), '**Merge**: done · <1m');
});

test('stepComment keeps the last 40 lines of a command in a fence', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  const body = stepComment({ label: 'Merge', outcome: 'done', ms: 0, output: lines.join('\n') + '\n', command: true }).split('\n\n')[1]!;
  assert.equal(body, ['```', ...lines.slice(10), '```'].join('\n'));
  assert.match(stepComment({ label: 'Merge', outcome: 'done', ms: 0, output: 'a ``` b', command: true }), /~~~\na ``` b\n~~~$/);
});

test('stepComment cuts at 4,000 characters, a command from the end and an agent from the start', () => {
  const long = 'a'.repeat(3000) + 'b'.repeat(3000);
  const agent = stepComment({ label: 'Editor', outcome: 'done', ms: 0, output: long, log: '01-editor.log' });
  assert.ok(agent.includes('a'.repeat(3000) + 'b'.repeat(1000) + '\n\n(cut to 4,000 characters, full log: 01-editor.log)'));
  assert.ok(!agent.includes('b'.repeat(1001)));
  const command = stepComment({ label: 'Merge', outcome: 'done', ms: 0, output: long, command: true, log: '00-merge.log' });
  assert.ok(command.includes('```\n' + 'a'.repeat(1000) + 'b'.repeat(3000) + '\n```\n\n(cut to 4,000 characters, full log: 00-merge.log)'));
  assert.ok(!command.includes('a'.repeat(1001)));
  assert.ok(!stepComment({ label: 'Editor', outcome: 'done', ms: 0, output: 'short' }).includes('cut to'));
});

test('stepComment falls back to the error when a failed step printed nothing', () => {
  assert.equal(stepComment({ label: 'Merge', outcome: 'failed', ms: 0, output: '', error: 'conflict', command: true }), '**Merge**: failed · <1m\n\n```\nconflict\n```');
  assert.equal(stepComment({ label: 'Editor', outcome: 'failed', ms: 0, error: 'out of credits' }), '**Editor**: failed · <1m\n\nout of credits');
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

test('a parked run and an unexpected error each ping once, as parked and failed', async () => {
  const kinds: string[] = [];
  const { rc } = setup({ comments: async () => { throw new Error('stop'); }, comment: async () => {}, setLabels: async () => {} });
  rc.notify = async (e) => void kinds.push(`${e.kind} ${e.card} ${e.workflow} ${e.reason}`);
  rc.config.projects.p = { path: '/nonexistent' };
  assert.equal(await runCard(card(['a']), wf('a').triggers[0]!, 'one', wf('a'), rc.config.projects.p, rc), 'parked');
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  mkdirSync(join(repo, '.git'));
  rc.config.projects.p = { path: repo };
  assert.equal(await runCard(card(['a']), wf('a').triggers[0]!, 'one', wf('a'), rc.config.projects.p, rc), 'failed');
  assert.deepEqual(kinds, ['parked ENG-1 one The project folder /nonexistent is not a git repository on this Mac.', 'failed ENG-1 one Something went wrong: stop']);
});

test('the dispatcher asks for the summary on every pass, paused or not', async () => {
  const { rc } = setup({});
  const seen: boolean[] = [];
  rc.summary = async (paused) => void seen.push(paused);
  setPaused(rc.configDir, true);
  assert.equal(await dispatch(rc, fakeStarts([])), 0);
  rc.summary = async () => { throw new Error('boom'); };
  setPaused(rc.configDir, false);
  assert.equal(await dispatch(rc, fakeStarts([])), 0);
  assert.deepEqual(seen, [true]);
});

test('maxRuns 1 starts one child when two workspaces both have work', async () => {
  const events: string[] = [];
  const { rc, configDir } = setup({ myCardsWithLabel: async () => [card(['a'], 'ENG', 'ENG-1', 'Alpha'), card(['a'], 'ENG', 'ENG-2', 'Beta')] }, { one: wf('a') });
  twoWorkspaces(rc, configDir);
  rc.config.maxRuns = 1;
  assert.equal(await dispatch(rc, fakeStarts(events)), 0);
  assert.deepEqual(events, ['start ENG-1', 'exit ENG-1', 'start ENG-2', 'exit ENG-2'], 'one at a time');
});

test('maxRuns 1 with a live card run in one workspace starts nothing in the other', async () => {
  const child = fakeRunner();
  try {
    const events: string[] = [];
    const { rc, configDir } = setup({ myCardsWithLabel: async () => [card(['a'], 'ENG', 'ENG-2', 'Beta')] }, { one: wf('a') });
    twoWorkspaces(rc, configDir);
    rc.config.maxRuns = 1;
    holdWorkspace(configDir, 'wa', child.pid!);
    assert.equal(await dispatch(rc, fakeStarts(events)), 0);
    assert.deepEqual(events, []);
  } finally {
    child.kill();
  }
});

test('a lock with no card takes no slot under the cap', async () => {
  const child = fakeRunner();
  try {
    const events: string[] = [];
    const { rc, configDir } = setup({ myCardsWithLabel: async () => [card(['a'], 'ENG', 'ENG-2', 'Beta')] }, { one: wf('a') });
    twoWorkspaces(rc, configDir);
    rc.config.maxRuns = 1;
    mkdirSync(join(agentsDir(configDir), 'locks'), { recursive: true });
    writeFileSync(workspaceLockPath(configDir, 'wa'), JSON.stringify({ pid: child.pid, workspace: 'wa', startedAt: new Date().toISOString() }));
    assert.equal(await dispatch(rc, fakeStarts(events)), 0);
    assert.deepEqual(events, ['start ENG-2', 'exit ENG-2']);
  } finally {
    child.kill();
  }
});

test('a held window starts nothing and says so once', async () => {
  const events: string[] = [];
  const { rc, configDir, logs } = setup({ myCardsWithLabel: async () => [card(['a'])] }, { one: wf('a') });
  rc.config.projects.p = { path: '/p' };
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  writeWindow(configDir, { checkedAt: new Date().toISOString(), utilization: 91, resetsAt });
  let reads = 0;
  assert.equal(await dispatch(rc, { ...fakeStarts(events), window: async () => void reads++ }), 0);
  assert.deepEqual(events, []);
  assert.equal(reads, 0, 'a fresh reading is not read again');
  assert.equal(logs.filter((l) => /5 hour window is at 91%/.test(l)).length, 1);
  assert.equal(await tick(rc), 0);
  assert.match(logs.at(-1)!, /no new run starts until/);
  writeWindow(configDir, { checkedAt: new Date().toISOString(), utilization: 89, resetsAt });
  assert.equal(await dispatch(rc, fakeStarts(events)), 0);
  assert.deepEqual(events, ['start ENG-1', 'exit ENG-1']);
});

test('a stale window is read before the first pass', async () => {
  const { rc } = setup({ myCardsWithLabel: async () => [] }, { one: wf('a') });
  let reads = 0;
  assert.equal(await dispatch(rc, { ...fakeStarts([]), window: async () => void reads++ }), 0);
  assert.equal(reads, 1);
});
