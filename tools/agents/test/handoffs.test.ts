import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/engine.ts';
import { DEFAULTS, agentsDir, type Workflow } from '../src/config.ts';
import { cronCard, findJobs, lastLine, runCard, tick, type RunContext } from '../src/runner.ts';
import { closeStale, listRuns, queueHandoffs, readHandoffs, runsDir, writeHandoffs, writeRun, type RunRecord } from '../src/state.ts';
import type { Card } from '../src/linear.ts';
import type { Tracker } from '../src/tracker.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'vsf-handoff-'));

const card = (identifier: string, labels: string[] = []): Card => ({ id: '1', identifier, title: 'T', url: 'u', branchName: `b-${identifier}`, teamId: 't', teamKey: identifier.split('-')[0]!, labels });

const cronTrigger = { source: 'cron' as const, schedule: '0 5 * * *', task: 'Scout' };
const target: Workflow = { triggers: [{ source: 'linear', team: 'ENG', label: 'go' }], steps: ['vs-qa'], maxRounds: 1, project: 'p' };

function setup(workflows: Record<string, Workflow>, linear: Partial<Tracker> = {}) {
  const configDir = tmp();
  mkdirSync(agentsDir(configDir), { recursive: true });
  const logs: string[] = [];
  const rc: RunContext = {
    configDir,
    config: { ...structuredClone(DEFAULTS), workflows },
    trackers: () => linear as Tracker,
    log: (l) => void logs.push(l),
    selfCommand: [],
  };
  return { rc, configDir, logs };
}

// A project folder that looks like a repo, which is all a command-only run needs.
function fakeRepo() {
  const repo = tmp();
  mkdirSync(join(repo, '.git'));
  return repo;
}

test('runCommand returns stdout and logs the command, stdout and stderr', async () => {
  const dir = tmp();
  const logFile = join(dir, 'c.log');
  const r = await runCommand({ command: 'echo out; echo err >&2; echo "$VSF_X"', cwd: dir, logFile, env: { VSF_X: 'hello' } });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'out\nhello\n');
  assert.equal(r.error, undefined);
  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /^\$ echo out; echo err >&2/);
  assert.match(log, /err/);
  assert.match(log, /exit 0/);
});

test('a failing command says why from its stderr, or its exit code', async () => {
  const dir = tmp();
  const a = await runCommand({ command: 'echo boom >&2; exit 3', cwd: dir, logFile: join(dir, 'a.log') });
  assert.deepEqual(a, { ok: false, output: '', error: 'boom' });
  const b = await runCommand({ command: 'exit 4', cwd: dir, logFile: join(dir, 'b.log') });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'exit 4');
});

test('a command that runs past its timeout is stopped and says so', async () => {
  const dir = tmp();
  const r = await runCommand({ command: 'sleep 5', cwd: dir, logFile: join(dir, 't.log'), timeoutMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timed out after 0 minutes');
});

test('lastLine is the last non-empty line, cut to 300 chars', () => {
  assert.equal(lastLine('one\n two \n\n'), 'two');
  assert.equal(lastLine(''), '');
  assert.equal(lastLine('x'.repeat(400)).length, 300);
});

test('a command-only scheduled run makes no worktree, ends done and keeps the last line', async () => {
  const { rc, configDir, logs } = setup({});
  const repo = fakeRepo();
  rc.config.projects.p = { path: repo, base: 'main' };
  const workflow: Workflow = { triggers: [cronTrigger], steps: [{ id: 'scan', run: 'echo first; echo "pwd=$PWD"; echo "$VSF_WORKFLOW done"', output: 'none' }], maxRounds: 1, project: 'p' };
  const c = cronCard('scout', 'Scout', new Date());
  assert.equal(await runCard(c, cronTrigger, 'scout', workflow, rc.config.projects.p, rc), 'done', logs.join('\n'));
  assert.equal(existsSync(join(agentsDir(configDir), 'worktrees', c.identifier)), false);
  const record = listRuns(configDir, c.identifier)[0]!.record!;
  assert.equal(record.outcome, 'done');
  assert.equal(record.steps[0]!.summary, 'scout done');
  assert.ok(logs.includes(`${c.identifier} done`));
});

test('a step with a handoff queues the HANDOFF cards once and records them', async () => {
  const { rc, configDir, logs } = setup({ target });
  rc.config.projects.p = { path: fakeRepo(), base: 'main' };
  const workflow: Workflow = { triggers: [cronTrigger], steps: [{ id: 'scan', run: 'echo hi; echo "HANDOFF: eng-5"; echo "  HANDOFF: ENG-7  "; echo "HANDOFF: ENG-5"; echo "not HANDOFF: ENG-9"', output: 'none', handoff: 'target' }], maxRounds: 1, project: 'p' };
  const c = cronCard('scout', 'Scout', new Date());
  assert.equal(await runCard(c, cronTrigger, 'scout', workflow, rc.config.projects.p, rc), 'done', logs.join('\n'));
  assert.deepEqual(readHandoffs(configDir).map((h) => [h.card, h.workflow, h.from]), [['ENG-5', 'target', c.identifier], ['ENG-7', 'target', c.identifier]]);
  assert.deepEqual(listRuns(configDir, c.identifier)[0]!.record!.steps[0]!.handoffs, ['ENG-5', 'ENG-7']);
  assert.ok(logs.includes(`${c.identifier} handed ENG-5, ENG-7 to target`));
});

test('a handoff to a workflow that does not exist queues nothing', async () => {
  const { rc, configDir, logs } = setup({});
  rc.config.projects.p = { path: fakeRepo(), base: 'main' };
  const workflow: Workflow = { triggers: [cronTrigger], steps: [{ id: 'scan', run: 'echo "HANDOFF: ENG-5"', output: 'none', handoff: 'nope' }], maxRounds: 1, project: 'p' };
  const c = cronCard('scout', 'Scout', new Date());
  assert.equal(await runCard(c, cronTrigger, 'scout', workflow, rc.config.projects.p, rc), 'done');
  assert.deepEqual(readHandoffs(configDir), []);
  assert.ok(logs.includes(`${c.identifier} cannot hand cards to nope: no such workflow`));
});

test('findJobs returns a queued handoff for its workflow without the label, and drops stale or unknown ones', async () => {
  const { rc, configDir, logs } = setup({ target }, {});
  rc.config.projects.p = { path: '/p' };
  rc.trackers = () => ({ card: async (id: string) => card(id), myCardsWithLabel: async () => [] }) as unknown as Tracker;
  const now = new Date();
  const old = new Date(now.getTime() - 25 * 3600_000).toISOString();
  writeHandoffs(configDir, [
    { card: 'ENG-1', workflow: 'target', from: 'X-1', at: old },
    { card: 'ENG-2', workflow: 'gone', from: 'X-1', at: now.toISOString() },
    { card: 'OPS-3', workflow: 'target', from: 'X-1', at: now.toISOString() },
    { card: 'ENG-4', workflow: 'target', from: 'X-1', at: now.toISOString() },
  ]);
  const jobs = await findJobs(rc, { now });
  assert.deepEqual(jobs.map((j) => [j.card.identifier, j.workflow]), [['ENG-4', 'target']]);
  assert.deepEqual(readHandoffs(configDir).map((h) => h.card), ['ENG-4']);
  assert.equal(logs.length, 3, logs.join('\n'));
});

test('a handoff whose card cannot be read stays queued', async () => {
  const { rc, configDir, logs } = setup({ target });
  rc.config.projects.p = { path: '/p' };
  rc.trackers = () => ({ card: async () => { throw new Error('down'); }, myCardsWithLabel: async () => [] }) as unknown as Tracker;
  queueHandoffs(configDir, 'target', ['ENG-4'], 'X-1');
  assert.deepEqual(await findJobs(rc), []);
  assert.equal(readHandoffs(configDir).length, 1);
  assert.ok(logs.some((l) => l.startsWith('Could not read ENG-4 for its handoff (down)')));
});

test('tick takes the handoff off the queue once its run has started', async () => {
  const calls: string[] = [];
  const { rc, configDir } = setup({ target }, {
    card: async (id) => card(id),
    myCardsWithLabel: async () => [],
    comments: async () => [],
    comment: async () => void calls.push('comment'),
    setLabels: async () => void calls.push('labels'),
  });
  rc.config.projects.p = { path: '/nonexistent' };
  queueHandoffs(configDir, 'target', ['ENG-4'], 'X-1');
  assert.equal(await tick(rc), 1);
  assert.deepEqual(readHandoffs(configDir), []);
  assert.deepEqual(listRuns(configDir, 'ENG-4')[0]!.record!.outcome, 'parked');
});

test('park writes the outcome before any tracker call', async () => {
  const { rc, configDir } = setup({ target });
  rc.config.projects.p = { path: '/nonexistent' };
  const c = card('ENG-1', ['go']);
  let seen = '';
  // A tracker whose comment throws, after noting what was on disk.
  rc.trackers = () => ({
    comments: async () => [],
    comment: async () => {
      seen = listRuns(configDir, 'ENG-1')[0]!.record!.outcome;
      throw new Error('tracker down');
    },
    setLabels: async () => {},
  }) as unknown as Tracker;
  assert.equal(await runCard(c, target.triggers[0]!, 'target', target, rc.config.projects.p, rc), 'parked');
  assert.equal(seen, 'parked');
  assert.equal(listRuns(configDir, 'ENG-1')[0]!.record!.outcome, 'parked');
});

test('a failed command step ends the run failed', async () => {
  const { rc, configDir, logs } = setup({});
  rc.config.projects.p = { path: fakeRepo(), base: 'main' };
  const workflow: Workflow = { triggers: [cronTrigger], steps: [{ id: 'scan', run: 'echo bad >&2; exit 2', output: 'none' }], maxRounds: 1, project: 'p' };
  const c = cronCard('scout', 'Scout', new Date());
  assert.equal(await runCard(c, cronTrigger, 'scout', workflow, rc.config.projects.p, rc), 'failed');
  const record = listRuns(configDir, c.identifier)[0]!.record!;
  assert.equal(record.outcome, 'failed');
  assert.match(record.reason!, /The scan step failed: bad/);
  assert.ok(logs.some((l) => l.includes('failed: The scan step failed')));
});

test('a scheduled command run writes nothing to a tracker', async () => {
  const writes: string[] = [];
  const { rc, logs } = setup({}, { comment: async () => void writes.push('comment'), setLabels: async () => void writes.push('labels') });
  rc.config.projects.p = { path: fakeRepo(), base: 'main' };
  const workflow: Workflow = { triggers: [cronTrigger], steps: [{ id: 'scan', run: 'echo hi', output: 'none' }, { id: 'boom', run: 'exit 2', output: 'none' }], maxRounds: 1, project: 'p' };
  assert.equal(await runCard(cronCard('scout', 'Scout', new Date()), cronTrigger, 'scout', workflow, rc.config.projects.p, rc), 'failed', logs.join('\n'));
  assert.deepEqual(writes, []);
});

test('closeStale closes a running record with no live lock and leaves a live one', () => {
  const configDir = tmp();
  const make = (card: string, stamp: string) => {
    const dir = join(runsDir(configDir), card, stamp);
    mkdirSync(dir, { recursive: true });
    const run: RunRecord = { card, title: 'T', workflow: 'w', trigger: '', steps: [{ step: 's', label: 'S', startedAt: '2026-10-23T10:00:00.000Z' }], outcome: 'running', workspace: 'default', startedAt: '2026-10-23T09:59:00.000Z' };
    writeRun(dir, run);
    return dir;
  };
  const dead = make('A-1', '2026-10-23T10-00-00-000Z');
  const live = make('B-1', '2026-10-23T10-00-00-000Z');
  assert.deepEqual(closeStale(configDir, [{ runDir: live, card: 'B-1' }]), ['A-1']);
  const closed = JSON.parse(readFileSync(join(dead, 'run.json'), 'utf8')) as RunRecord;
  assert.equal(closed.outcome, 'failed');
  assert.equal(closed.endedAt, '2026-10-23T10:00:00.000Z');
  assert.equal(closed.steps[0]!.result, 'stopped');
  assert.equal(JSON.parse(readFileSync(join(live, 'run.json'), 'utf8')).outcome, 'running');
});
