import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { awakeLines, checksLines, checksView, clampFocus, countsLine, Home, HOME_LIMITS, agentItems, homeHints, homeLists, recentRows, liveCard, liveCards, memoryLines, jobRows, nextSection, parkedRows, runnerLines, sectionsFor } from '../src/tui/home.ts';
import { emptyState, runsThisWeek, updateNotice, type AgentsStatus, type DataState, type RunItem } from '../src/tui/data.ts';
import { barParts, cycle, editText, fitCell } from '../src/tui/widgets.ts';
import { duration, minutesText, secondsToNextCheck, truncate } from '../src/tui/format.ts';
import { fakeData, newSpy, withFakes } from './tui-helpers.ts';
import { theme } from '../src/tui/theme.ts';

const text = (line: { text: string }[]) => line.map((s) => s.text).join('');

test('sections follow the added tools and Checks is always last', () => {
  assert.deepEqual(sectionsFor([]), ['checks']);
  assert.deepEqual(sectionsFor(['memory', 'agents']), ['agents', 'memory', 'checks']);
  assert.deepEqual(sectionsFor(['agents', 'awake', 'memory']), ['agents', 'awake', 'memory', 'checks']);
});

test('tab cycles focus in both directions and wraps', () => {
  const s = sectionsFor(['agents', 'awake']);
  assert.equal(nextSection(s, 'agents', 1), 'awake');
  assert.equal(nextSection(s, 'checks', 1), 'agents');
  assert.equal(nextSection(s, 'agents', -1), 'checks');
  assert.equal(nextSection(s, 'memory', 1), 'agents');
  assert.equal(clampFocus(sectionsFor(['awake']), 'agents'), 'awake');
  assert.equal(clampFocus(s, 'awake'), 'awake');
});

test('an update is announced only when npm has a newer version', () => {
  assert.equal(updateNotice({ current: '0.3.0', latest: '0.3.1', checked: true }), '0.3.1');
  assert.equal(updateNotice({ current: '0.3.0', latest: '0.3.0', checked: true }), null);
  assert.equal(updateNotice({ current: '0.3.1', latest: '0.3.0', checked: true }), null);
  assert.equal(updateNotice({ current: '0.3.0', latest: null, checked: false }), null);
});

const NOW = Date.parse('2026-10-20T14:03:30.000Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const agents: AgentsStatus = {
  runner: 'running',
  lastTick: { at: new Date(NOW - 19_000).toISOString(), line: 'ok' },
  current: { pid: 1, card: 'ENG-1412', title: 'Webhook retries drop the payload', workflow: 'tether-relay-build', step: 'QA', round: 0, startedAt: iso(12), runDir: '/r/1', elapsedMinutes: 12 },
  parked: [{ card: 'ENG-1407', reason: 'checks still failed after 3 rounds' }],
  interrupted: ['ENG-1399'],
  workflows: 1,
  projects: 2,
};

const runs: RunItem[] = [
  {
    card: 'ENG-1412',
    stamp: 's',
    dir: '/r/1',
    logs: [],
    record: {
      card: 'ENG-1412',
      title: 'Webhook retries drop the payload',
      workflow: 'tether-relay-build',
      outcome: 'running',
      startedAt: iso(12),
      steps: [
        { step: 'vs-dev', label: 'Dev', startedAt: iso(12), endedAt: iso(3), result: 'done' },
        { step: 'vs-qa', label: 'QA', startedAt: iso(3) },
      ],
    },
  },
  { card: 'ENG-1300', stamp: 'o', dir: '/r/2', logs: [], record: { card: 'ENG-1300', title: 'old', workflow: 'w', outcome: 'verified', startedAt: iso(60 * 24 * 10), steps: [] } },
];

const base: DataState = {
  ...emptyState(['agents']),
  agents,
  runs,
  workflows: [{ name: 'tether-relay-build', triggers: [], steps: ['vs-dev', 'vs-qa'], maxRounds: 3, project: 'p' }],
  agentsConfig: { timeoutMinutes: 45 },
  loaded: true,
};

test('the live card shows each workflow step as done, running or pending', () => {
  const live = liveCard(base, NOW)!;
  assert.equal(live.card, 'ENG-1412');
  assert.deepEqual(live.steps.map((s) => [s.label, s.state]), [['Dev', 'done'], ['QA', 'running']]);
  assert.equal(live.round, 1);
  assert.equal(live.maxRounds, 3);
  assert.equal(live.minutes, 12);
});

test('steps not reached yet are pending, and a sent-back check shows failed', () => {
  const noRecord = liveCard({ ...base, runs: [], agents: { ...agents, current: { ...agents.current!, step: 'Dev' } } }, NOW)!;
  assert.deepEqual(noRecord.steps.map((s) => s.state), ['running', 'pending']);
  const sentBack: RunItem = {
    ...runs[0]!,
    record: {
      ...runs[0]!.record!,
      steps: [
        { step: 'vs-dev', label: 'Dev', startedAt: iso(30), endedAt: iso(20), result: 'done' },
        { step: 'vs-qa', label: 'QA', startedAt: iso(20), endedAt: iso(10), result: 'FIX' },
        { step: 'vs-dev', label: 'Dev', startedAt: iso(10) },
      ],
    },
  };
  const live = liveCard({ ...base, runs: [sentBack], agents: { ...agents, current: { ...agents.current!, step: 'Dev', round: 2 } } }, NOW)!;
  assert.deepEqual(live.steps.map((s) => s.state), ['running', 'failed']);
  assert.equal(live.round, 2, 'the lock round is 1-based already');
  assert.equal(liveCard({ ...base, agents: { ...agents, current: { ...agents.current!, round: 1 } } }, NOW)!.round, 1);
});

// The live card above, plus a second one in another workspace.
const twoRunning: AgentsStatus = {
  ...agents,
  running: [
    { ...agents.current!, workspace: 'tether' },
    { pid: 2, card: 'DS06-12', title: 'Invoice export', workflow: 'erp-build', step: 'Dev', round: 1, startedAt: iso(4), elapsedMinutes: 4, workspace: 'solvia' },
  ],
};

test('each workspace with a run gets its own live card', () => {
  const lives = liveCards({ ...base, agents: twoRunning }, NOW);
  assert.deepEqual(lives.map((l) => [l.workspace, l.card]), [['solvia', 'DS06-12'], ['tether', 'ENG-1412']]);
});

test('no live card without a card in the lock', () => {
  assert.equal(liveCard({ ...base, agents: { ...agents, current: null } }, NOW), null);
  assert.equal(liveCard({ ...base, agents: { ...agents, current: { pid: 1, checking: true } } }, NOW), null);
});

test('runner line shows state, last check and the countdown', () => {
  const r = runnerLines(agents, NOW);
  assert.equal(text(r.left), '● Runner running');
  assert.match(text(r.right), /^last check \d\d:\d\d · next in 41s$/);
  assert.match(text(runnerLines({ ...agents, runner: 'paused' }, NOW).left), /paused/);
  assert.equal(text(runnerLines({ ...agents, runner: 'running', lastTick: { at: iso(5), line: '' } }, NOW).right).includes('due now'), true);
  assert.equal(runnerLines({ ...agents, runner: 'stopped', lastTick: null }, NOW).right.length, 0);
});

test('the runner line shows the 5 hour window, and the hold in yellow', () => {
  const window = { checkedAt: iso(1), utilization: 61.7, resetsAt: iso(-120), heldUntil: null };
  const open = runnerLines({ ...agents, window }, NOW);
  assert.equal(text(open.left), '● Runner running');
  assert.match(text(open.right), /^5h 62% · last check \d\d:\d\d · next in 41s$/);
  const held = runnerLines({ ...agents, window: { ...window, utilization: 91, heldUntil: iso(-120) } }, NOW);
  assert.match(text(held.left), /^● Runner held: 5h window 91% until \d\d:\d\d$/);
  assert.equal(held.left[1]!.colour, theme.yellow);
  assert.ok(!text(held.right).includes('5h'));
  assert.equal(text(runnerLines({ ...agents, window: null }, NOW).right).includes('5h'), false, 'no window, no segment');
});

test('parked and interrupted cards are what r can retry', () => {
  assert.deepEqual(parkedRows(agents).map((p) => [p.card, p.kind]), [['ENG-1407', 'parked'], ['ENG-1399', 'interrupted']]);
  assert.match(parkedRows(agents)[0]!.text, /^parked: checks still failed/);
});

test('failed cards are retryable rows, one per card', () => {
  const a: AgentsStatus = { ...agents, failed: [{ card: 'ENG-1500', reason: 'process died' }, { card: 'ENG-1407' }] };
  assert.deepEqual(parkedRows(a).map((p) => [p.card, p.kind]), [['ENG-1407', 'parked'], ['ENG-1500', 'failed'], ['ENG-1399', 'interrupted']]);
  assert.equal(parkedRows(a)[1]!.text, 'failed: process died');
});

test('job lines show the last good run, or a yellow failure', () => {
  const job = { workflow: 'scout', schedule: '0 */6 * * *', task: 't', last: { at: iso(10), outcome: 'verified' }, lastOkAt: iso(10), today: { runs: 3, failed: 0, handed: 2 } };
  const a: AgentsStatus = { ...agents, jobs: [job, { ...job, workflow: 'sweep', last: { at: iso(5), outcome: 'failed', reason: 'process died' } }] };
  const rows = jobRows(a);
  assert.match(rows[0]!.text, /^scout {2}cron 0 \*\/6 \* \* \* {2}last ok \d\d:\d\d · 3 today · 2 handed$/);
  assert.equal(rows[0]!.bad, false);
  assert.match(rows[1]!.text, /^! sweep last failed \d\d:\d\d: process died$/);
  assert.equal(rows[1]!.bad, true);
  assert.deepEqual(jobRows(agents), []);
});

test('counts line and weekly run count', () => {
  assert.equal(runsThisWeek(runs, NOW), 1);
  assert.equal(countsLine(agents, runs, NOW), '1 workflow · 2 projects · 1 run this week');
  const cron: RunItem = { ...runs[0]!, dir: '/r/cron', record: { ...runs[0]!.record!, source: 'cron' } };
  assert.equal(countsLine(agents, [...runs, cron], NOW), '1 workflow · 2 projects · 1 run this week');
});

test('awake lines for on, off and held by another tool', () => {
  const on = awakeLines({ on: true, sleepDisabledByOther: false, since: iso(60), until: new Date(NOW + 530 * 60_000).toISOString(), minutesLeft: 530, batteryFloor: 20, floorApplies: true, power: { onBattery: true, percent: 86 }, watchdog: true, lastReason: null });
  assert.match(text(on[0]!), /^● On since \d\d:\d\d, the lid can close$/);
  assert.match(text(on[1]!), /^ {2}stops \d\d:\d\d \(8h 50m\) or at 20%$/);
  assert.equal(text(on[2]!), '  on battery, 86% · watchdog ok');
  const off = awakeLines({ on: false, sleepDisabledByOther: false, since: null, until: null, minutesLeft: null, batteryFloor: 20, floorApplies: false, power: { onBattery: false, percent: 90 }, watchdog: false, lastReason: 'you turned it off' });
  assert.equal(text(off[0]!), '○ Off. The Mac sleeps normally.');
  assert.match(text(off[2]!), /on power adapter · watchdog not loaded/);
  assert.match(text(awakeLines({ ...{ on: false } as never, sleepDisabledByOther: true, power: { onBattery: false, percent: null } })[0]!), /not by VoidShift/);
});

test('memory lines flag notes missing from INDEX.md', () => {
  const lines = memoryLines(
    { vault: '/v', isVault: true, notes: 214, indexed: 211, unindexed: { count: 3, names: [] }, lastUpdated: iso(5), homes: [{ kind: 'claude', dir: '/h/.claude', recall: 'on', skill: 'linked' }] },
    new Date(NOW),
  );
  assert.equal(text(lines[0]!), '214 notes · 3 not in INDEX.md');
  assert.match(text(lines[1]!), /^recall on in Claude Code /);
  assert.match(text(lines[2]!), /^last note \d\d:\d\d$/);
});

test('checks summarise counts and list problems with their fix, failures first', () => {
  const checks = [
    { name: 'git', status: 'ok' as const, detail: 'x' },
    { name: 'agents', status: 'warn' as const, detail: 'missing vs-qa', fix: 'vsf agents link ~/x' },
    { name: 'Linear', status: 'fail' as const, detail: 'no key', fix: 'vsf agents key' },
  ];
  const v = checksView(checks);
  assert.deepEqual([v.ok, v.warn, v.fail, v.problems[0]!.name], [1, 1, 1, 'Linear']);
  const rows = checksLines(checks);
  assert.match(text(rows[0]!.left), /^✓ 1 ok {3}! 1 warning {3}✗ 1 failed {2}Linear no key {2}fix: vsf agents key$/);
  assert.match(text(rows[1]!.left), /^! agents missing vs-qa/);
  assert.equal(text(checksLines([{ name: 'a', status: 'ok', detail: '' }])[0]!.left), '✓ 1 ok');
});

test('home hints follow the runner state and the tools added', () => {
  const keys = (o: Parameters<typeof homeHints>[0]) => homeHints(o).map((h) => h.key);
  assert.deepEqual(keys({ runner: 'running', hasAwake: true }), ['tab', 'enter', '←→', 'p', 'a', ':', '?', 'q']);
  assert.deepEqual(keys({ hasAwake: false }), ['tab', 'enter', ':', '?', 'q']);
  assert.equal(homeHints({ runner: 'paused', hasAwake: false })[3]!.label, 'resume runner');
});

test('progress bars, text editing and small formatters', () => {
  assert.deepEqual(barParts('done', 0, 4), { filled: '━━━━', head: '', rest: '' });
  assert.deepEqual(barParts('running', 0.5, 12), { filled: '━━━━━━', head: '╸', rest: '─────' });
  assert.deepEqual(barParts('pending', 0, 3), { filled: '', head: '', rest: '───' });
  assert.deepEqual(editText('ab', 2, 'c', {}), { value: 'abc', cursor: 3 });
  assert.deepEqual(editText('abc', 1, '', { backspace: true }), { value: 'bc', cursor: 0 });
  assert.deepEqual(editText('abc', 3, '', { delete: true }), { value: 'ab', cursor: 2 });
  assert.deepEqual(editText('abc', 1, '', { leftArrow: true }), { value: 'abc', cursor: 0 });
  assert.deepEqual(editText('abc', 3, 'u', { ctrl: true }), { value: '', cursor: 0 });
  assert.deepEqual(editText('ab', 2, '', { return: true }), { value: 'ab', cursor: 2 });
  assert.deepEqual(editText('', 0, 'x\ny', {}), { value: 'xy', cursor: 2 });
  assert.equal(cycle(3, 2, 1), 0);
  assert.equal(cycle(3, 0, -1), 2);
  assert.equal(fitCell('abcdef', 4), 'abc…');
  assert.equal(fitCell('ab', 4), 'ab  ');
  assert.equal(duration(12 * 60_000), '12m');
  assert.equal(duration(64 * 60_000), '1h 4m');
  assert.equal(minutesText(530), '8h 50m');
  assert.equal(truncate('a  b', 10), 'a b');
  assert.equal(secondsToNextCheck(new Date(NOW - 19_000).toISOString(), NOW), 41);
});

test('Home renders the live card, a parked card and the other sections', () => {
  const spy = newSpy();
  const data = fakeData({
    ...base,
    tools: ['agents', 'awake', 'memory'],
    awake: { on: true, sleepDisabledByOther: false, since: iso(60), until: null, minutesLeft: null, batteryFloor: 20, floorApplies: true, power: { onBattery: true, percent: 86 }, watchdog: true, lastReason: null },
    memory: { vault: '/v', isVault: true, notes: 214, indexed: 211, unindexed: { count: 3, names: [] }, lastUpdated: iso(5), homes: [] },
    checks: [{ name: 'git', status: 'ok', detail: 'x' }, { name: 'agents', status: 'warn', detail: 'missing vs-qa', fix: 'vsf agents link' }],
    update: { current: '0.3.0', latest: '0.3.1', checked: true },
  });
  const r = render(withFakes(spy, data, React.createElement(Home)));
  const frame = r.lastFrame()!;
  for (const want of ['Agents', '● Runner running', '▶ ENG-1412', 'Webhook retries drop the payload', 'Dev ━━━━━━━━━━━━ ✓', 'QA ', 'round 1 of 3', '! ENG-1407', 'parked: checks still failed after 3 rounds', 'enter opens · tether-relay-build', 'Cards', 'Jobs 0', 'ENG-1300', 'All runs', '1 workflow · 2 projects', 'Awake', 'On since', 'Memory', '214 notes · 3 not in INDEX.md', 'Checks', '✓ 1 ok', '! 1 warning', 'agents missing vs-qa']) {
    assert.ok(frame.includes(want), `missing "${want}" in:\n${frame}`);
  }
  assert.deepEqual(spy.hints?.map((h) => h.key), ['tab', 'enter', '←→', 'p', 'a', ':', '?', 'q']);
  r.unmount();
});

test('Home shows one live block per workspace, named next to the workflow', () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ ...base, agents: twoRunning, checks: [] }), React.createElement(Home)));
  const frame = r.lastFrame()!;
  r.unmount();
  for (const want of ['▶ ENG-1412', 'tether · tether-relay-build', '▶ DS06-12', 'Invoice export', 'solvia · erp-build']) assert.ok(frame.includes(want), `missing "${want}" in:\n${frame}`);
  assert.ok(!frame.includes('Checking'));
});

test('Home hides sections of tools that are not added', () => {
  const spy = newSpy();
  const data = fakeData({ ...emptyState(['awake']), loaded: true, checks: [] });
  const r = render(withFakes(spy, data, React.createElement(Home)));
  const frame = r.lastFrame()!;
  r.unmount();
  assert.ok(frame.includes('Awake'));
  assert.ok(!frame.includes('Agents'));
  assert.ok(!frame.includes('Memory'));
});

test('keys: enter opens the selected card, r retries, p and a ask the command', async () => {
  const spy = newSpy();
  const data = fakeData({ ...base, tools: ['agents', 'awake'], awake: { on: false, sleepDisabledByOther: false, since: null, until: null, minutesLeft: null, batteryFloor: 20, floorApplies: false, power: { onBattery: false, percent: null }, watchdog: true, lastReason: null } });
  const r = render(withFakes(spy, data, React.createElement(Home)));
  const press = async (s: string) => {
    r.stdin.write(s);
    await new Promise((res) => setTimeout(res, 30));
  };
  await press('\r');
  assert.deepEqual(spy.pushed.at(-1), { id: 'agents.card', params: { card: 'ENG-1412' } });
  await press('r');
  assert.equal(spy.ran.length, 0, 'r on a live card retries nothing');
  await press('\u001b[B');
  await press('\r');
  assert.deepEqual(spy.pushed.at(-1), { id: 'agents.card', params: { card: 'ENG-1407' } });
  await press('r');
  await press('p');
  await press('a');
  const args = spy.ran.map((s) => (s as { args: string[] }).args.join(' '));
  assert.deepEqual(args, ['agents retry ENG-1407', 'agents pause', 'awake on']);
  assert.match((spy.ran[2] as { body: string }).body, /until the battery drops to 20% or you run "vsf awake off"/);
  await press('\t');
  await press('\r');
  assert.equal(spy.pushed.at(-1)!.id, 'awake');
  r.unmount();
});

test('Home shows a few parked cards and jobs, and counts the rest', () => {
  const job = { workflow: 'scout', schedule: '*/15 * * * *', task: 't', last: { at: iso(10), outcome: 'done' }, lastOkAt: iso(10), today: { runs: 3, failed: 0, handed: 0 } };
  const many: AgentsStatus = {
    ...agents,
    interrupted: [],
    failed: Array.from({ length: 48 }, (_, i) => ({ card: `ENG-${1000 + i}`, reason: 'process died' })),
    jobs: Array.from({ length: 8 }, (_, i) => ({ ...job, workflow: `job${i}` })),
  };
  const l = homeLists(many);
  assert.equal(l.parked.length, HOME_LIMITS.attention);
  assert.equal(l.moreParked, 49 - HOME_LIMITS.attention);
  assert.equal(l.jobs.length, HOME_LIMITS.jobs);
  assert.equal(l.moreJobs, 8 - HOME_LIMITS.jobs);
  assert.deepEqual(homeLists(null), { parked: [], recent: [], jobs: [], moreParked: 0, moreJobs: 0 });
});

test('a long list never pushes Memory and Checks off a short terminal', () => {
  const spy = newSpy();
  const many: AgentsStatus = { ...agents, failed: Array.from({ length: 48 }, (_, i) => ({ card: `ENG-${1000 + i}`, reason: 'process died' })) };
  const data = fakeData({
    ...base,
    agents: many,
    tools: ['agents', 'awake', 'memory'],
    awake: { on: false, sleepDisabledByOther: false, since: null, until: null, minutesLeft: null, batteryFloor: 20, floorApplies: true, power: { onBattery: false, percent: 90 }, watchdog: true, lastReason: null },
    memory: { vault: '/v', isVault: true, notes: 331, indexed: 330, unindexed: { count: 1, names: [] }, lastUpdated: iso(5), homes: [] },
    checks: [{ name: 'git', status: 'ok', detail: 'x' }],
  });
  const r = render(withFakes(spy, data, React.createElement(Home), { rows: 30 }));
  const frame = r.lastFrame()!;
  const lines = frame.split('\n');
  assert.ok(lines.length <= 27, `Home is ${lines.length} rows tall:\n${frame}`);
  for (const want of ['Agents', 'more · All runs lists them', 'Memory', '331 notes · 1 not in INDEX.md', 'Checks', '✓ 1 ok']) assert.ok(frame.includes(want), `missing "${want}" in:\n${frame}`);
  assert.ok(!frame.includes('ENG-1047'), 'the 48th failed card should be left out');
  r.unmount();
});

test('recent cards skip live and parked ones, and the switch lists cards or jobs', () => {
  const rows = recentRows({ agents, runs }, new Set(['ENG-1412']));
  assert.deepEqual(rows.map((r) => [r.card, r.outcome]), [['ENG-1300', 'verified']]);
  const job = { workflow: 'scout', schedule: '*/15 * * * *', task: 't', last: { at: iso(10), outcome: 'done' }, lastOkAt: iso(10), today: { runs: 3, failed: 0, handed: 0 } };
  const lists = homeLists({ ...agents, jobs: [job] }, runs, ['ENG-1412']);
  assert.deepEqual(agentItems('cards', ['ENG-1412'], lists), [
    { kind: 'live', card: 'ENG-1412' },
    { kind: 'parked', card: 'ENG-1407' },
    { kind: 'parked', card: 'ENG-1399' },
    { kind: 'recent', card: 'ENG-1300' },
    { kind: 'all' },
  ]);
  assert.deepEqual(agentItems('jobs', ['ENG-1412'], lists), [{ kind: 'job', job: 'scout' }]);
});

test('right arrow switches Home to jobs, and enter opens the job', async () => {
  const spy = newSpy();
  const job = { workflow: 'tether-qa-scout', schedule: '*/15 * * * *', task: 't', last: { at: iso(10), outcome: 'done' }, lastOkAt: iso(10), today: { runs: 16, failed: 0, handed: 0 } };
  const r = render(withFakes(spy, fakeData({ ...base, agents: { ...agents, jobs: [job] }, checks: [] }), React.createElement(Home)));
  const press = async (s: string) => {
    r.stdin.write(s);
    await new Promise((res) => setTimeout(res, 30));
  };
  await press('\u001b[C');
  const frame = r.lastFrame()!;
  assert.ok(frame.includes('tether-qa-scout  cron */15 * * * *'), frame);
  assert.ok(!frame.includes('▶ ENG-1412'), 'live cards belong to the Cards view');
  await press('\r');
  assert.deepEqual(spy.pushed.at(-1), { id: 'agents.card', params: { job: 'tether-qa-scout' } });
  await press('\u001b[D');
  for (let i = 0; i < 4; i++) await press('\u001b[B');
  await press('\r');
  assert.deepEqual(spy.pushed.at(-1), { id: 'agents', params: { tab: 'agents.runs' } });
  r.unmount();
});
