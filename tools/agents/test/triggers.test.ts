import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastDue, matches, parseCron } from '../src/cron.ts';
import { DEFAULTS, agentsDir, triggerSpec, type Trigger, type Workflow } from '../src/config.ts';
import { parseTrigger, sameTrigger, validateWorkflow } from '../src/manage.ts';
import { createVoidTrack, mapIssue } from '../src/voidtrack.ts';
import { cronCard, nextJob, runCard, tick, type RunContext } from '../src/runner.ts';
import { readCronState } from '../src/state.ts';
import type { Card } from '../src/linear.ts';
import type { Tracker } from '../src/tracker.ts';

const at = (iso: string) => new Date(iso);

test('cron fields: lists, ranges, steps, Sunday as 0 or 7, bad input refused', () => {
  const s = parseCron('*/15 9-17 * * 1-5')!;
  assert.ok(matches(s, new Date(2026, 9, 23, 9, 45)));
  assert.ok(!matches(s, new Date(2026, 9, 23, 9, 50)));
  assert.ok(!matches(s, new Date(2026, 9, 25, 9, 45)), 'Sunday');
  assert.ok(matches(parseCron('0 5 * * 7')!, new Date(2026, 9, 25, 5, 0)), '7 is Sunday');
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *']) assert.equal(parseCron(bad), null, bad);
});

test('day of month and day of week match either way when both are set', () => {
  const s = parseCron('0 0 1 * 1')!;
  assert.ok(matches(s, new Date(2026, 9, 1, 0, 0)), 'the 1st, a Thursday');
  assert.ok(matches(s, new Date(2026, 9, 5, 0, 0)), 'a Monday');
  assert.ok(!matches(s, new Date(2026, 9, 6, 0, 0)));
});

test('lastDue returns the latest missed minute once, and not past a day', () => {
  const s = parseCron('0 * * * *')!;
  const since = new Date(2026, 9, 23, 4, 30);
  assert.deepEqual(lastDue(s, since, new Date(2026, 9, 23, 7, 10)), new Date(2026, 9, 23, 7, 0));
  assert.equal(lastDue(s, new Date(2026, 9, 23, 7, 0), new Date(2026, 9, 23, 7, 59)), null, 'the minute already fired');
  assert.equal(lastDue(parseCron('0 0 1 1 *')!, new Date(2020, 0, 1), new Date(2026, 9, 23)), null, 'older than a day is skipped');
});

test('trigger strings round trip for Linear, VoidTrack and cron', () => {
  const cases: [string, Trigger][] = [
    ['eng:vs-plan', { source: 'linear', team: 'ENG', label: 'vs-plan' }],
    ['linear:ENG:vs-plan', { source: 'linear', team: 'ENG', label: 'vs-plan' }],
    ['voidtrack:org:vs-start', { source: 'voidtrack', team: 'ORG', label: 'vs-start' }],
    ['cron:0  5 * * 1:Update deps: all of them', { source: 'cron', schedule: '0 5 * * 1', task: 'Update deps: all of them' }],
  ];
  for (const [input, want] of cases) {
    const got = parseTrigger(input)!;
    assert.deepEqual(got, want, input);
    assert.ok(sameTrigger(parseTrigger(triggerSpec(got))!, got), triggerSpec(got));
  }
  for (const bad of ['ENG', 'cron:61 * * * *:x', 'cron:0 5 * * 1:', 'voidtrack::x']) assert.equal(parseTrigger(bad), null, bad);
});

test('validateWorkflow checks schedules and tasks', () => {
  const base = { steps: ['vs-qa' as const], maxRounds: 2, project: 'p' };
  const config = { enabled: [], projects: { p: { path: '/x' } } };
  assert.deepEqual(validateWorkflow(config, { ...base, triggers: [{ source: 'cron', schedule: '0 5 * * 1', task: 'go' }] }), []);
  const bad = validateWorkflow(config, { ...base, triggers: [{ source: 'cron', schedule: 'nope', task: ' ' }] });
  assert.equal(bad.length, 2);
});

function fakeFetch(routes: Record<string, (body?: any) => [number, unknown]>, calls: string[]) {
  return (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://web.voidtrack.app/api', '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(`${key}${init?.body ? ` ${init.body}` : ''}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer vt_key');
    const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
    const [status, body] = hit ? hit[1](init?.body ? JSON.parse(String(init.body)) : undefined) : [404, { error: 'no route' }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const issue = (identifier: string, labels: string[]) => ({ id: `id-${identifier}`, identifier, title: 'Do it', team: { id: 't', key: identifier.split('-')[0] }, labels });

test('VoidTrack client: my labelled cards, labels, comments, moves, viewer', async () => {
  const calls: string[] = [];
  const vt = createVoidTrack(
    'vt_key',
    fakeFetch(
      {
        'GET /v1/users': () => [200, { users: [{ id: 'u1', name: 'Other', isMe: false }, { id: 'u2', name: 'Me', isMe: true }] }],
        'GET /v1/issues?': () => [200, { issues: [issue('ORG-1', ['vs-start']), issue('ORG-2', ['other'])] }],
        'PATCH /v1/issues/ORG-1': (b) => (b.state === 'Nope' ? [400, { error: 'no state' }] : [200, { issue: issue('ORG-1', b.labels ?? []) }]),
        'POST /v1/issues/ORG-1/comments': () => [201, { comment: {} }],
      },
      calls,
    ),
  );
  assert.deepEqual(await vt.viewer(), { id: 'u2', name: 'Me' });
  const cards = await vt.myCardsWithLabel('vs-start', 'ORG');
  assert.deepEqual(cards.map((c) => c.identifier), ['ORG-1']);
  assert.match(calls[1]!, /team=ORG&assignee=me&stateType=backlog,unstarted,started/);
  await vt.setLabels(cards[0]!, ['vs-dev']);
  assert.deepEqual(cards[0]!.labels, ['vs-dev']);
  await vt.comment(cards[0]!, 'hi');
  assert.equal(await vt.moveTo(cards[0]!, 'In Review'), true);
  assert.equal(await vt.moveTo(cards[0]!, 'Nope'), false);
  assert.ok(calls.includes('PATCH /v1/issues/ORG-1 {"labels":["vs-dev"]}'));
  assert.ok(calls.includes('POST /v1/issues/ORG-1/comments {"body":"hi"}'));
});

test('a VoidTrack card gets a stable branch and a web link', () => {
  const c = mapIssue(issue('ORG-292', ['a']), 'https://web.voidtrack.app');
  assert.equal(c.branchName, 'org-292');
  assert.equal(c.url, 'https://web.voidtrack.app/issue/ORG-292');
  assert.equal(c.teamKey, 'ORG');
});

test('a scheduled run gets a card id the commands accept and its own branch', () => {
  const c = cronCard('Nightly deps', 'Update deps\nand fix', at('2026-10-23T05:00:00Z'));
  assert.match(c.identifier, /^[A-Za-z][A-Za-z0-9]*-\d+$/);
  assert.equal(c.branchName, 'vs/nightly-deps-202610230500');
  assert.equal(c.title, 'Update deps');
});

function rcWith(workflows: Record<string, Workflow>, trackers: Partial<Record<'linear' | 'voidtrack', Partial<Tracker>>>) {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-triggers-'));
  mkdirSync(agentsDir(configDir), { recursive: true });
  const logs: string[] = [];
  const rc: RunContext = {
    configDir,
    config: { ...structuredClone(DEFAULTS), workflows },
    trackers: (kind) => {
      const t = trackers[kind];
      if (!t) throw new Error(`No ${kind} API key`);
      return t as Tracker;
    },
    log: (l) => void logs.push(l),
    selfCommand: ['vsf'],
  };
  return { rc, configDir, logs };
}

const vtCard = (labels: string[]): Card => ({ id: '1', identifier: 'ORG-1', title: 'T', url: 'u', branchName: 'org-1', teamId: 't', teamKey: 'ORG', labels });
const flow = (triggers: Trigger[]): Workflow => ({ triggers, steps: ['vs-qa'], maxRounds: 2, project: 'p' });

test('a schedule starts counting when first seen, fires once when due, and survives a restart', async () => {
  const { rc, configDir } = rcWith({ nightly: flow([{ source: 'cron', schedule: '0 5 * * *', task: 'Tidy up' }]) }, {});
  assert.equal(await nextJob(rc, undefined, undefined, { now: at('2026-10-23T04:00:30Z') }), null);
  assert.ok(readCronState(configDir)['nightly 0 5 * * *'], 'first sight recorded');
  const tz = new Date(2026, 9, 23, 5, 0);
  assert.equal(await nextJob(rc, undefined, undefined, { now: new Date(tz.getTime() - 60_000) }), null, 'not yet due');
  const job = await nextJob(rc, undefined, undefined, { now: new Date(tz.getTime() + 30_000) });
  assert.equal(job?.workflow, 'nightly');
  assert.equal(job?.card.description, 'Tidy up');
  assert.equal(await nextJob(rc, undefined, undefined, { now: new Date(tz.getTime() + 90_000) }), null, 'fired once');
});

test('a named workflow with a schedule can be run now', async () => {
  const { rc } = rcWith({ nightly: flow([{ source: 'cron', schedule: '0 5 * * *', task: 'Tidy up' }]) }, {});
  assert.equal((await nextJob(rc, undefined, 'nightly', { force: true }))?.workflow, 'nightly');
});

test('VoidTrack triggers ask VoidTrack, and one tracker failing does not stop the rest', async () => {
  const { rc, logs } = rcWith(
    {
      tether: flow([{ source: 'linear', team: 'ENG', label: 'vs-start' }]),
      self: flow([{ source: 'voidtrack', team: 'ORG', label: 'vs-start' }]),
    },
    { voidtrack: { myCardsWithLabel: async (label: string, team: string) => (team === 'ORG' ? [vtCard([label])] : []) } },
  );
  const job = await nextJob(rc);
  assert.equal(job?.workflow, 'self');
  assert.equal(job?.card.identifier, 'ORG-1');
  assert.match(logs[0]!, /Could not check Linear for ENG \+ vs-start \(No linear API key\)/);
});

test('a pinned VoidTrack card is read from VoidTrack', async () => {
  const { rc } = rcWith({ self: flow([{ source: 'voidtrack', team: 'ORG', label: 'vs-start' }]) }, { voidtrack: { card: async () => vtCard(['vs-parked']) } });
  assert.equal((await nextJob(rc, 'ORG-1'))?.workflow, 'self');
});

test('a scheduled run without a Plan step uses its task as the plan instead of parking for one', async () => {
  const { rc, logs } = rcWith({ nightly: { ...flow([{ source: 'cron', schedule: '0 5 * * *', task: 'Tidy up' }]), steps: ['vs-dev', 'vs-qa'] } }, {});
  // A real repo with no remote: the run gets past the plan check and parks on git fetch.
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  rc.config.projects.p = { path: repo, base: 'main' };
  const { runCard } = await import('../src/runner.ts');
  const outcome = await runCard(cronCard('nightly', 'Tidy up', new Date()), rc.config.workflows.nightly!.triggers[0]!, 'nightly', rc.config.workflows.nightly!, rc.config.projects.p, rc);
  assert.equal(outcome, 'failed');
  assert.ok(logs.some((l) => /failed: .*git fetch/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /No plan comment/.test(l)));
});

// A real repo with a bare origin, a fake `claude` that logs its argv and
// stdin then runs behave.sh, and a fake `gh`, for runs that reach the agents.
function agentRig(behave: string) {
  const root = mkdtempSync(join(tmpdir(), 'vsf-rig-'));
  const git = (args: string[], cwd: string) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  const origin = join(root, 'origin.git');
  git(['init', '-q', '--bare', '-b', 'main', origin], root);
  const repo = join(root, 'repo');
  git(['clone', '-q', origin, repo], root);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
  git(['push', '-q', 'origin', 'HEAD:main'], repo);
  const bin = join(root, 'bin');
  const fake = join(root, 'fake');
  mkdirSync(bin);
  mkdirSync(join(fake, 'calls'), { recursive: true });
  writeFileSync(join(fake, 'behave.sh'), behave);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
n=$(ls "${fake}/calls" | wc -l | tr -d ' ')
mkdir -p "${fake}/calls/$n"
printf '%s\\n' "$@" > "${fake}/calls/$n/argv"
cat > "${fake}/calls/$n/stdin"
. "${fake}/behave.sh"
`);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho https://github.com/x/y/pull/1\n');
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  const defs = join(root, 'defs');
  mkdirSync(defs);
  const prompts: Record<string, string> = {
    'brief.md': 'Write the morning brief.',
    'plan.md': 'Write a custom plan.\nRESULT: DONE',
    'check.md': 'Check the custom plan.\nVERDICT: SHIP',
    'build.md': 'Build it the custom way.\nRESULT: DONE',
  };
  for (const [name, text] of Object.entries(prompts)) writeFileSync(join(defs, name), text);
  const calls = () =>
    readdirSync(join(fake, 'calls')).sort((a, b) => Number(a) - Number(b)).map((n) => ({
      argv: readFileSync(join(fake, 'calls', n, 'argv'), 'utf8').split('\n'),
      stdin: readFileSync(join(fake, 'calls', n, 'stdin'), 'utf8'),
    }));
  return { repo, bin, defs, calls };
}

// The fake agent commits a new file each time, then reports.
const COMMIT = 'f=$(date +%s%N).txt; echo x > "$f"; git add "$f"; git -c user.name=t -c user.email=t@t commit -q -m work >/dev/null\n';

async function withPath<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

const cron: Trigger = { source: 'cron', schedule: '0 5 * * *', task: 'Brief me' };

async function runCron(rig: ReturnType<typeof agentRig>, workflow: Workflow, platform: NodeJS.Platform = 'darwin') {
  const { rc, logs } = rcWith({ w: workflow }, {});
  rc.selfCommand = [];
  rc.platform = platform;
  rc.config.projects.p = { path: rig.repo, base: 'main' };
  rc.config.folders = { w: rig.defs };
  const outcome = await withPath(rig.bin, () => runCard(cronCard('w', 'Brief me', new Date()), cron, 'w', workflow, rc.config.projects.p!, rc));
  return { outcome, logs };
}

test('a custom one step prompt runs from cron with its own model, timeout and write access, and no tracker', async () => {
  const rig = agentRig('echo brief written\n');
  const { outcome, logs } = await runCron(rig, { triggers: [cron], steps: [{ id: 'brief', prompt: 'brief.md', output: 'none', model: 'haiku', timeoutMinutes: 5, write: true }], maxRounds: 1, project: 'p' });
  assert.equal(outcome, 'done', logs.join('\n'));
  const [call] = rig.calls();
  assert.match(call!.stdin, /Write the morning brief\./);
  assert.match(call!.stdin, /Brief me/);
  assert.equal(call!.argv[call!.argv.indexOf('--model') + 1], 'haiku');
  assert.ok(call!.argv.includes('acceptEdits'), 'write access');
  assert.equal(rig.calls().length, 1);
});

test('the workspace context reaches the step prompt', async () => {
  const rig = agentRig('echo done\n');
  const workflow: Workflow = { triggers: [cron], steps: [{ id: 'brief', prompt: 'brief.md', output: 'none' }], maxRounds: 1, project: 'p' };
  const { rc, logs } = rcWith({ w: workflow }, {});
  rc.selfCommand = [];
  rc.platform = 'darwin';
  const root = mkdtempSync(join(tmpdir(), 'vsf-ws-'));
  writeFileSync(join(root, 'CONTEXT.md'), 'Solvia clients ship to staging.\n');
  rc.config.workspaces = { solvia: { root } };
  rc.config.projects.p = { path: rig.repo, base: 'main', workspace: 'solvia' };
  rc.config.folders = { w: rig.defs };
  const outcome = await withPath(rig.bin, () => runCard(cronCard('w', 'Brief me', new Date()), cron, 'w', workflow, rc.config.projects.p!, rc));
  assert.equal(outcome, 'done', logs.join('\n'));
  assert.match(rig.calls()[0]!.stdin, /# Workspace\n\nSolvia clients ship to staging\./);
});

test('a custom step that fails parks the run with its stderr', async () => {
  const rig = agentRig('echo boom >&2; exit 3\n');
  const { outcome, logs } = await runCron(rig, { triggers: [cron], steps: [{ id: 'brief', prompt: 'brief.md', output: 'none' }], maxRounds: 1, project: 'p' });
  assert.equal(outcome, 'failed');
  assert.ok(logs.some((l) => /The brief step failed: boom\. Log: 00-brief\.log/.test(l)), logs.join('\n'));
  assert.ok(!rig.calls()[0]!.argv.includes('acceptEdits'), 'a none step is read only by default');
});

test('a custom verdict sends FIX back to a custom plan step until the rounds run out', async () => {
  const rig = agentRig('echo "RESULT: DONE"; echo "VERDICT: FIX"\n');
  const { outcome, logs } = await runCron(rig, {
    triggers: [cron],
    steps: [{ id: 'plan', prompt: 'plan.md', output: 'plan' }, { id: 'check', prompt: 'check.md', output: 'verdict' }],
    maxRounds: 2,
    project: 'p',
  });
  assert.equal(outcome, 'parked');
  assert.ok(logs.some((l) => /Checks still failed after 2 plan rounds/.test(l)), logs.join('\n'));
  assert.equal(rig.calls().filter((c) => c.stdin.includes('Write a custom plan.')).length, 2);
  assert.equal(rig.calls().filter((c) => c.stdin.includes('Check the custom plan.')).length, 2);
});

test('on Linux every step skips permissions instead of an allowlist', async () => {
  const rig = agentRig('echo brief written\n');
  const { outcome, logs } = await runCron(rig, { triggers: [cron], steps: [{ id: 'brief', prompt: 'brief.md', output: 'none' }], maxRounds: 1, project: 'p' }, 'linux');
  assert.equal(outcome, 'done', logs.join('\n'));
  const { argv, stdin } = rig.calls()[0]!;
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.ok(!argv.includes('--allowedTools'));
  assert.match(stdin, /If the environment stops you/);
});

test('a verdict step that crashes ends the run as failed, with no Dev round', async () => {
  const rig = agentRig('echo "out of credits" >&2; exit 3\n');
  const { outcome, logs } = await runCron(rig, {
    triggers: [cron],
    steps: [{ id: 'check', prompt: 'check.md', output: 'verdict' }, { id: 'build', prompt: 'build.md', output: 'commits' }],
    maxRounds: 3,
    project: 'p',
  });
  assert.equal(outcome, 'failed');
  assert.equal(rig.calls().length, 1);
  assert.ok(logs.some((l) => /failed: The check step failed: out of credits/.test(l)), logs.join('\n'));
});

test('a plan step that crashes pings Discord as failed with its stderr', async () => {
  const rig = agentRig('echo "bash: rg: command not found" >&2; exit 3\n');
  const { rc, logs, writes, run } = cardRig(rig, { triggers: [vtTrigger], steps: [{ id: 'plan', prompt: 'plan.md', output: 'plan' }, 'vs-dev'], maxRounds: 2, project: 'p' });
  rc.platform = 'darwin';
  const events: { kind: string; reason?: string }[] = [];
  rc.notify = async (e) => void events.push(e);
  assert.equal(await run(), 'failed', logs.join('\n'));
  assert.equal(rig.calls().length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'failed');
  assert.match(events[0]!.reason!, /The plan step failed: bash: rg: command not found\. Log: 00-plan\.log/);
  assert.ok(writes.some((w) => w.startsWith('comment:**Parked:** The plan step failed')), writes.join('\n'));
});

test('a read step leaves a clean worktree', async () => {
  // Each step notes what git sees before it strays, so a leftover shows up in the next one.
  const rig = agentRig('git status --porcelain >> ../status.txt; echo stray > stray.txt; echo "VERDICT: SHIP"\n');
  const { rc, logs } = rcWith({}, {});
  const workflow: Workflow = { triggers: [cron], steps: [{ id: 'check', prompt: 'check.md', output: 'verdict' }, { id: 'again', prompt: 'check.md', output: 'verdict' }], maxRounds: 1, project: 'p' };
  rc.selfCommand = [];
  rc.platform = 'darwin';
  rc.config.workflows = { w: workflow };
  rc.config.projects.p = { path: rig.repo, base: 'main' };
  rc.config.folders = { w: rig.defs };
  const card = cronCard('w', 'Brief me', new Date());
  assert.equal(await withPath(rig.bin, () => runCard(card, cron, 'w', workflow, rc.config.projects.p!, rc)), 'done', logs.join('\n'));
  assert.equal(readFileSync(join(agentsDir(rc.configDir), 'worktrees', 'status.txt'), 'utf8'), '');
  assert.equal(existsSync(join(agentsDir(rc.configDir), 'worktrees', card.identifier)), false, 'a scheduled run with no PR leaves no worktree');
});

test('a custom commits step gets write access by default and its commits count', async () => {
  const rig = agentRig(`${COMMIT}echo "RESULT: DONE"\n`);
  const { outcome, logs } = await runCron(rig, { triggers: [cron], steps: [{ id: 'build', prompt: 'build.md', output: 'commits' }], maxRounds: 1, project: 'p' });
  assert.equal(outcome, 'done', logs.join('\n'));
  assert.ok(rig.calls()[0]!.argv.includes('acceptEdits'));
  assert.ok(!logs.some((l) => /made no commits/.test(l)));
});

// A card run's tracker, recording every write.
function cardRig(rig: ReturnType<typeof agentRig>, workflow: Workflow, comments: { body: string; createdAt: string }[] = []) {
  const writes: string[] = [];
  const tracker: Partial<Tracker> = {
    card: async () => vtCard(['vs-start', 'keep']),
    myCardsWithLabel: async () => [vtCard(['vs-start', 'keep'])],
    comments: async () => comments,
    comment: async (_c, body) => void writes.push(`comment:${body}`),
    setLabels: async (c, next) => {
      writes.push(`labels:${next.join(',')}`);
      c.labels = next;
    },
    moveTo: async (_c, state) => {
      writes.push(`move:${state}`);
      return true;
    },
  };
  const { rc, logs } = rcWith({ w: workflow }, { voidtrack: tracker });
  rc.selfCommand = [];
  rc.platform = 'darwin';
  rc.config.projects.p = { path: rig.repo, base: 'main' };
  rc.config.folders = { w: rig.defs };
  const trigger = workflow.triggers[0]!;
  const run = (card = vtCard(['vs-start', 'keep'])) => withPath(rig.bin, () => runCard(card, trigger, 'w', workflow, rc.config.projects.p!, rc));
  return { rc, logs, writes, run };
}

const vtTrigger: Trigger = { source: 'voidtrack', team: 'ORG', label: 'vs-start' };

test('a custom plan step before Dev means no plan comment is needed', async () => {
  const rig = agentRig(`${COMMIT}echo "RESULT: DONE"\n`);
  const { logs, run } = cardRig(rig, { triggers: [vtTrigger], steps: [{ id: 'plan', prompt: 'plan.md', output: 'plan' }, 'vs-dev'], maxRounds: 1, project: 'p' });
  const outcome = await run();
  assert.ok(!logs.some((l) => /No plan comment/.test(l)), logs.join('\n'));
  assert.equal(outcome, 'verified', logs.join('\n'));
});

test('writeBack: labels off, a fixed state and no closing comment', async () => {
  const rig = agentRig('echo done\n');
  const { writes, logs, run } = cardRig(rig, {
    triggers: [vtTrigger],
    steps: [{ id: 'brief', prompt: 'brief.md', output: 'none' }],
    maxRounds: 1,
    project: 'p',
    writeBack: { labels: false, state: 'Done', comment: false },
  });
  assert.equal(await run(), 'verified', logs.join('\n'));
  assert.deepEqual(writes, ['move:Done', 'labels:keep']);
});

test('writeBack.state null never moves the card', async () => {
  const rig = agentRig(`${COMMIT}echo "RESULT: DONE"\n`);
  const { writes, logs, run } = cardRig(rig, { triggers: [vtTrigger], steps: ['vs-dev'], maxRounds: 1, project: 'p', writeBack: { state: null } }, [{ body: '## Plan\n\nDo it.', createdAt: '2026-10-23T00:00:00Z' }]);
  assert.equal(await run(), 'verified', logs.join('\n'));
  assert.ok(!writes.some((w) => w.startsWith('move:')), writes.join('\n'));
  assert.ok(writes.some((w) => w.startsWith('comment:**All checks passed.**')));
});

test('--from a custom step on a card picked by its trigger', async () => {
  const rig = agentRig('echo done\n');
  const workflow: Workflow = { triggers: [vtTrigger], steps: [{ id: 'first', prompt: 'plan.md', output: 'none' }, { id: 'brief', prompt: 'brief.md', output: 'none' }], maxRounds: 1, project: 'p' };
  const { rc, logs } = cardRig(rig, workflow);
  assert.equal(await withPath(rig.bin, () => tick(rc, 'ORG-1', { from: 'x' })), 2);
  assert.ok(logs.includes('Workflow w has no x step'.concat('.')), logs.join('\n'));
  assert.equal(rig.calls().length, 0);
  assert.equal(await withPath(rig.bin, () => tick(rc, 'ORG-1', { from: 'brief' })), 0, logs.join('\n'));
  assert.equal(rig.calls().length, 1);
  assert.match(rig.calls()[0]!.stdin, /Write the morning brief\./);
});

test('a broken profile settings file parks the run with a clear reason', async () => {
  const { rc, logs } = rcWith({ nightly: flow([{ source: 'cron', schedule: '0 5 * * *', task: 'Tidy up' }]) }, {});
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  rc.config.projects.p = { path: repo, base: 'main' };
  const { profileDir } = await import('../src/profile.ts');
  const { writeFileSync: write } = await import('node:fs');
  mkdirSync(profileDir(rc.configDir), { recursive: true });
  write(join(profileDir(rc.configDir), 'claude-settings.json'), '{ nope');
  const { runCard } = await import('../src/runner.ts');
  const wf = rc.config.workflows.nightly!;
  assert.equal(await runCard(cronCard('nightly', 'Tidy up', new Date()), wf.triggers[0]!, 'nightly', wf, rc.config.projects.p, rc), 'parked');
  assert.ok(logs.some((l) => /parked: Your agent profile's Claude settings are broken/.test(l)), logs.join('\n'));
});

test('a verified run with a PR pings ready once, and a throwing ping leaves it verified', async () => {
  const rig = agentRig(`${COMMIT}echo "RESULT: DONE"\n`);
  const { rc, logs, run } = cardRig(rig, { triggers: [vtTrigger], steps: ['vs-dev'], maxRounds: 1, project: 'p' }, [{ body: '## Plan\n\nDo it.', createdAt: '2026-10-23T00:00:00Z' }]);
  const kinds: string[] = [];
  rc.notify = async (e) => void kinds.push(`${e.kind} ${e.prUrl}`);
  assert.equal(await run(), 'verified', logs.join('\n'));
  assert.deepEqual(kinds, ['ready https://github.com/x/y/pull/1']);
  rc.notify = async () => { throw new Error('webhook down'); };
  assert.equal(await run(), 'verified', logs.join('\n'));
  assert.ok(logs.some((l) => /discord: webhook down/.test(l)), logs.join('\n'));
});

test('a claude step that answers in JSON saves its usage on the step and the run', async () => {
  const json = JSON.stringify({ type: 'result', is_error: false, result: 'brief written', total_cost_usd: 0.25, modelUsage: { 'claude-haiku': { inputTokens: 900, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.25 } } });
  const rig = agentRig(`echo '${json}'\n`);
  const workflow: Workflow = { triggers: [cron], steps: [{ id: 'brief', prompt: 'brief.md', output: 'none' }, { id: 'again', prompt: 'brief.md', output: 'none' }], maxRounds: 1, project: 'p' };
  const { rc, logs } = rcWith({ w: workflow }, {});
  rc.selfCommand = [];
  rc.platform = 'darwin';
  rc.config.projects.p = { path: rig.repo, base: 'main' };
  rc.config.folders = { w: rig.defs };
  const card = cronCard('w', 'Brief me', new Date());
  assert.equal(await withPath(rig.bin, () => runCard(card, cron, 'w', workflow, rc.config.projects.p!, rc)), 'done', logs.join('\n'));
  const { listRuns } = await import('../src/state.ts');
  const run = listRuns(rc.configDir, card.identifier)[0]!.record!;
  assert.deepEqual(run.steps.map((s) => s.usage), [
    { input: 900, output: 100, cached: 0, model: 'claude-haiku', costUsd: 0.25 },
    { input: 900, output: 100, cached: 0, model: 'claude-haiku', costUsd: 0.25 },
  ]);
  assert.deepEqual(run.usage, { input: 1800, output: 200, cached: 0, costUsd: 0.5, models: ['claude-haiku'] });
  assert.equal(run.steps[0]!.summary, 'brief written');
});
