import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { editText, hasOtherScreens, isSkipped, nextIndex, problemLine, setArgs, settingRows, unsetArgs, settingsScreen } from '../src/tui/screens/settings.ts';
import { emptyForm, formSummary, onArgs, statusLines, type AwakeFull } from '../src/tui/screens/awake.ts';
import { parseProblems, problemLines, recallText, toggleArgs, tryArgs, vaultLines } from '../src/tui/screens/memory.ts';
import { checkRows, fixCommand, sortChecks } from '../src/tui/screens/checks.ts';
import { scrollBy, tailLines, windowOf } from '../src/tui/screens/list-window.ts';
import { fakeData, newSpy, withFakes } from './tui-helpers.ts';
import { awakeScreen } from '../src/tui/screens/awake.ts';
import { checksScreen } from '../src/tui/screens/checks.ts';
import { memoryScreen } from '../src/tui/screens/memory.ts';

const text = (line: { text: string }[]) => line.map((s) => s.text).join('');
const h = React.createElement;

test('settings rows are dotted, masked, and skip the structured keys', () => {
  const rows = settingRows('agents', {
    engine: 'claude',
    models: { dev: 'opus' },
    projects: { a: { path: '/x' } },
    workflows: {},
    enabled: true,
    apiKey: 'sk-123',
    timeoutMinutes: 900,
  });
  assert.deepEqual(rows.map((r) => r.key), ['agents.engine', 'agents.models.dev', 'agents.apiKey', 'agents.timeoutMinutes']);
  const secret = rows.find((r) => r.key === 'agents.apiKey')!;
  assert.equal(secret.shown, '****');
  assert.equal(secret.secret, true);
  assert.equal(secret.edit, '');
  assert.equal(rows[3]!.shown, '900');
  assert.ok(isSkipped('memory.homes.0.dir'));
  assert.ok(!isSkipped('memory.vault'));
  assert.ok(hasOtherScreens('agents', { projects: {} }));
  assert.ok(!hasOtherScreens('awake', { battery: 20 }));
});

test('edit text and command arguments', () => {
  assert.equal(editText('opus'), 'opus');
  assert.equal(editText('true'), '"true"');
  assert.equal(editText(15), '15');
  assert.equal(editText(['a']), '["a"]');
  assert.deepEqual(setArgs('awake.battery', '25'), ['config', 'set', 'awake.battery', '25']);
  assert.deepEqual(setArgs('x.y', '-5'), ['config', 'set', 'x.y', '--', '-5']);
  assert.deepEqual(unsetArgs('x.y'), ['config', 'unset', 'x.y']);
  assert.equal(problemLine('\n timeoutMinutes must be 1 to 480\nmore'), 'timeoutMinutes must be 1 to 480');
  assert.equal(nextIndex(3, 2, 1), 2);
  assert.equal(nextIndex(3, 0, -1), 0);
});

test('awake form builds the real command and validates the battery', () => {
  assert.deepEqual(onArgs(emptyForm()), { args: ['awake', 'on'] });
  assert.deepEqual(onArgs({ mode: 'until', value: '7am', battery: '20' }), { args: ['awake', 'on', '--until', '7am', '--battery', '20'] });
  assert.deepEqual(onArgs({ mode: 'for', value: '6h', battery: '' }), { args: ['awake', 'on', '--for', '6h'] });
  assert.ok('error' in onArgs({ mode: 'for', value: '6h', battery: '3' }));
  assert.ok('error' in onArgs({ mode: 'for', value: '6h', battery: 'abc' }));
  assert.equal(formSummary({ mode: 'for', value: '6h', battery: '20' }), 'Keep the Mac awake for 6h, stopping at 20% battery.');
});

const base: AwakeFull = {
  on: true,
  sleepDisabledByOther: false,
  since: new Date(2026, 9, 20, 22, 10).toISOString(),
  until: new Date(2026, 9, 21, 7, 0).toISOString(),
  minutesLeft: 530,
  batteryFloor: 20,
  floorApplies: true,
  power: { onBattery: true, percent: 86 },
  watchdog: true,
  lastReason: null,
  heat: true,
  revertOnReboot: false,
};

test('awake status shows time left, floor, power, watchdog and guardrails', () => {
  const out = statusLines(base).map(text).join('\n');
  assert.match(out, /On since 22:10, the lid can close/);
  assert.match(out, /07:00 \(8h 50m left\)/);
  assert.match(out, /floor 20%, applies now/);
  assert.match(out, /on battery, 86%/);
  assert.match(out, /heat stop on/);
  assert.match(out, /turn off after reboot off/);
  const off = statusLines({ ...base, on: false, lastReason: 'battery floor', watchdog: false }).map(text).join('\n');
  assert.match(off, /Off\. The Mac sleeps normally/);
  assert.match(off, /Last ended\s+battery floor/);
  assert.match(off, /not loaded/);
});

test('log helpers', () => {
  assert.deepEqual(tailLines('a\nb\nc\n\n', 2), ['b', 'c']);
  assert.deepEqual(windowOf(100, 50, 10), { start: 45, end: 55 });
  assert.deepEqual(windowOf(5, 4, 10), { start: 0, end: 5 });
  assert.deepEqual(windowOf(100, 99, 10), { start: 90, end: 100 });
  assert.equal(scrollBy(3, -10, 5), 0);
  assert.equal(scrollBy(3, 10, 5), 5);
});

test('memory shaping', () => {
  assert.equal(recallText('on').text, 'recall on');
  assert.equal(recallText('other').text, 'another hook recalls');
  assert.equal(recallText('off').text, 'recall off');
  assert.deepEqual(toggleArgs('on', { kind: 'claude', dir: '/h/.claude', recall: 'off', skill: 'on' }), ['memory', 'on', '/h/.claude']);
  assert.deepEqual(tryArgs('how do we deploy'), ['memory', 'try', 'how do we deploy']);
  assert.deepEqual(tryArgs('-x'), ['memory', 'try', '--', '-x']);
  const p = parseProblems(JSON.stringify({ unindexed: ['a.md'], brokenIndex: [], brokenLinks: [{ note: 'b.md', link: 'zed' }] }))!;
  const out = problemLines(p).map(text);
  assert.deepEqual(out, ['Not in INDEX.md, never recalled (1)', '  a.md', '[[links]] that match no note (1)', '  b.md: [[zed]]']);
  assert.match(text(problemLines({ unindexed: [], brokenIndex: [], brokenLinks: [] })[0]!), /looks good/);
  assert.equal(parseProblems('nope'), null);
  const v = vaultLines({ vault: '/v', isVault: true, notes: 5, indexed: 3, unindexed: { count: 2, names: ['x.md', 'y.md'] }, lastUpdated: null, homes: [] }).map(text).join('\n');
  assert.match(v, /Not indexed\s+2 notes/);
  assert.match(v, /x\.md/);
});

test('checks shaping', () => {
  const sorted = sortChecks([
    { name: 'a', status: 'ok', detail: '' },
    { name: 'b', status: 'warn', detail: '' },
    { name: 'c', status: 'fail', detail: '' },
    { name: 'd', status: 'warn', detail: '' },
  ]);
  assert.deepEqual(sorted.map((c) => c.name), ['c', 'b', 'd', 'a']);
  assert.deepEqual(fixCommand('vsf setup awake'), ['setup', 'awake']);
  assert.equal(fixCommand('gh auth login'), null);
  assert.equal(fixCommand('vsf'), null);
  assert.equal(fixCommand('vsf setup; rm -rf x'), null);
  assert.equal(fixCommand(undefined), null);
  assert.equal(checkRows([{ name: 'n', status: 'warn', detail: 'd', fix: 'f' }])[0]!.length, 4);
});

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('settings screen renders rows, hints and the other-screens line', async () => {
  const spy = newSpy();
  const data = fakeData({ tools: ['agents', 'awake'] });
  data.readConfig = (t) => (t === 'agents' ? { engine: 'claude', projects: { a: {} }, timeoutMinutes: 900 } : { battery: 20 });
  const { lastFrame, stdin, unmount } = render(withFakes(spy, data, h(settingsScreen.component, { params: { tool: 'agents' } })));
  await wait();
  const f = lastFrame()!;
  assert.match(f, /Tools/);
  assert.match(f, /engine\s+claude\s+claude or codex/);
  assert.match(f, /timeoutMinutes\s+900/);
  assert.match(f, /Projects, workflows and folders have their own screens\./);
  assert.doesNotMatch(f, /projects/);
  stdin.write('u');
  await wait();
  const ran = spy.ran[0] as { args: string[] };
  assert.deepEqual(ran.args, ['config', 'unset', 'agents.engine']);
  unmount();
});

test('settings edit saves through vsf config set and keeps the edit open on failure', async () => {
  const spy = newSpy();
  const data = fakeData({ tools: ['awake'] });
  data.readConfig = () => ({ battery: 20 });
  const props = withFakes(spy, data, h(settingsScreen.component, { params: {} }), {
    actions: {
      run: async (spec) => {
        spy.ran.push(spec);
        return { code: 1, output: 'battery must be a whole number from 5 to 95.' };
      },
      confirm: async () => true,
      detach: () => {},
      terminal: async () => 0,
    },
  });
  const { lastFrame, stdin, unmount } = render(props);
  await wait();
  stdin.write('\r');
  await wait();
  stdin.write('\u007f');
  await wait();
  stdin.write('\u007f');
  await wait();
  stdin.write('99');
  await wait();
  stdin.write('\r');
  await wait();
  assert.deepEqual((spy.ran[0] as { args: string[] }).args, ['config', 'set', 'awake.battery', '99']);
  assert.match(lastFrame()!, /battery must be a whole number/);
  unmount();
});

test('awake, memory and checks screens render without a terminal', async () => {
  const spy = newSpy();
  const data = fakeData({
    tools: ['awake', 'memory'],
    awake: base,
    memory: { vault: '/v', isVault: true, notes: 4, indexed: 4, unindexed: { count: 0, names: [] }, lastUpdated: null, homes: [{ kind: 'claude', dir: '/h/.claude', recall: 'on', skill: 'on' }] },
    checks: [
      { name: 'Node', status: 'ok', detail: 'v22' },
      { name: 'awake watchdog', status: 'fail', detail: 'not loaded', fix: 'vsf setup awake' },
    ],
  });
  for (const [screen, pattern] of [
    [awakeScreen, /Watchdog/],
    [memoryScreen, /recall on/],
    [checksScreen, /awake watchdog/],
  ] as const) {
    const { lastFrame, unmount } = render(withFakes(spy, data, h(screen.component, { params: {} })));
    await wait();
    assert.match(lastFrame()!, pattern);
    unmount();
  }
});
