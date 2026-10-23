import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastDue, matches, parseCron } from '../src/cron.ts';
import { DEFAULTS, agentsDir, triggerSpec, type Trigger, type Workflow } from '../src/config.ts';
import { parseTrigger, sameTrigger, validateWorkflow } from '../src/manage.ts';
import { createVoidTrack, mapIssue } from '../src/voidtrack.ts';
import { cronCard, nextJob, type RunContext } from '../src/runner.ts';
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
  assert.equal(outcome, 'parked');
  assert.ok(logs.some((l) => /parked: .*git fetch/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /No plan comment/.test(l)));
});
