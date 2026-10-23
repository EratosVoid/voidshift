import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import '../src/tui/screens.ts';
import { Runs, cancelSpec, filterRuns, isLive, logStepOf, manualLogPath, outcomeOf, roundsOf, runsDeps, runsKey, stepsLabel, windowStart } from '../src/tui/screens/runs.ts';
import { LogView, appendChunk, logFor, scrollBy, visibleRows, wrapLines } from '../src/tui/screens/log.ts';
import { nextTab } from '../src/tui/screens/agents.ts';
import type { AgentsStatus, RunItem, StepRecord } from '../src/tui/data.ts';
import { fakeData, newSpy, withFakes } from './tui-helpers.ts';

const step = (id: string, label: string, over: Partial<StepRecord> = {}): StepRecord => ({ step: id, label, startedAt: '2026-10-20T13:51:00.000Z', endedAt: '2026-10-20T14:00:00.000Z', result: 'done', summary: 'All good.', log: `${id}.log`, ...over });

const run = (card: string, over: Partial<RunItem> = {}, outcome: 'running' | 'verified' | 'cancelled' | 'parked' = 'verified'): RunItem => ({
  card,
  stamp: '2026-10-20T13-51-00',
  dir: `/tmp/runs/${card}/a`,
  logs: ['01-vs-dev.log', '02-vs-qa.log'],
  record: { card, title: 'Webhook retries drop the payload', workflow: 'tether-relay-build', steps: [step('vs-dev', 'Dev'), step('vs-qa', 'QA', outcome === 'running' ? { endedAt: undefined, result: undefined } : {})], outcome, startedAt: '2026-10-20T13:51:00.000Z' },
  ...over,
});

const agents = (card: string): AgentsStatus => ({ runner: 'running', lastTick: null, current: { pid: 1, card, step: 'QA', round: 0 }, parked: [], interrupted: [], workflows: 1, projects: 1 });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('filter matches card or workflow text', () => {
  const a = run('ENG-1412');
  const b = run('ENG-1399');
  b.record!.workflow = 'other';
  assert.deepEqual(filterRuns([a, b], 'eng-14').map((r) => r.card), ['ENG-1412']);
  assert.deepEqual(filterRuns([a, b], 'OTHER').map((r) => r.card), ['ENG-1399']);
  assert.equal(filterRuns([a, b], '  ').length, 2);
});

test('steps label, rounds and outcome', () => {
  const r = run('ENG-1', {}, 'running');
  assert.equal(stepsLabel(r.record!.steps), 'Dev → QA');
  assert.equal(roundsOf([step('vs-dev', 'Dev'), step('vs-qa', 'QA'), step('vs-dev', 'Dev')]), 2);
  assert.equal(roundsOf([]), 0);
  assert.equal(outcomeOf(r, { agents: agents('ENG-1') }), 'running');
  assert.equal(outcomeOf(r, { agents: agents('ENG-2') }), 'interrupted');
  assert.equal(isLive(r, { agents: agents('ENG-1') }), true);
  assert.equal(isLive(run('ENG-1'), { agents: agents('ENG-1') }), false);
  assert.equal(logStepOf(r)?.step, 'vs-qa');
  assert.equal(logStepOf(run('ENG-3'))?.step, 'vs-qa');
});

test('a run is live while any workspace is on it', () => {
  const r = run('ENG-1', {}, 'running');
  const two: AgentsStatus = { ...agents('ENG-2'), running: [{ pid: 2, card: 'ENG-2', workspace: 'a' }, { pid: 3, card: 'ENG-1', workspace: 'b' }] };
  assert.equal(outcomeOf(r, { agents: two }), 'running');
  assert.equal(isLive(r, { agents: two }), true);
  assert.equal(outcomeOf(r, { agents: { ...two, running: [] } }), 'interrupted');
});

test('key map and tab keys', () => {
  assert.equal(runsKey('c', {}), 'cancel');
  assert.equal(runsKey('r', {}), 'retry');
  assert.equal(runsKey('f', {}), 'from');
  assert.equal(runsKey('x', {}), 'clean');
  assert.equal(runsKey('/', {}), 'filter');
  assert.equal(runsKey('', { return: true }), 'open');
  assert.equal(runsKey('z', {}), null);
  assert.equal(nextTab(0, 5, '', { rightArrow: true }), 1);
  assert.equal(nextTab(0, 5, '', { leftArrow: true }), 4);
  assert.equal(nextTab(0, 5, '3', {}), 2);
  assert.equal(nextTab(0, 5, '6', {}), null);
});

test('cancel dialog text matches the design', () => {
  const s = cancelSpec('ENG-1412', 'QA');
  assert.equal(s.title, 'Cancel ENG-1412?');
  assert.equal(s.body, 'Stops the QA agent now. The card loses its VoidShift labels and gets a comment; add vs-plan again to restart it.');
  assert.deepEqual(s.args, ['agents', 'cancel', 'ENG-1412']);
  assert.equal(s.confirmLabel, 'Cancel card');
  assert.equal(s.cancelLabel, 'Keep running');
  assert.equal(manualLogPath('/x'), '/x/agents/manual.log');
});

test('windowStart keeps the selection visible', () => {
  assert.equal(windowStart(3, 2, 5, 0), 0);
  assert.equal(windowStart(20, 7, 5, 0), 3);
  assert.equal(windowStart(20, 1, 5, 3), 1);
});

test('log text: whole lines kept, partial waits, ansi stripped', () => {
  let t = appendChunk({ lines: [], partial: '' }, 'one\ntw');
  assert.deepEqual(t, { lines: ['one'], partial: 'tw' });
  t = appendChunk(t, 'o\n\u001b[31mred\u001b[0m\r\n');
  assert.deepEqual(t.lines, ['one', 'two', 'red']);
  assert.equal(t.partial, '');
});

test('long lines wrap to the width', () => {
  assert.deepEqual(wrapLines(['a'.repeat(20), '', 'ok'], 8), ['aaaaaaaa', 'aaaaaaaa', 'aaaa', '', 'ok']);
});

test('scrolling turns follow off and stays in range', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `l${i}`);
  assert.deepEqual(visibleRows(rows, 5, { top: null }), ['l25', 'l26', 'l27', 'l28', 'l29']);
  const s = scrollBy({ top: null }, 30, 5, -1);
  assert.equal(s.top, 24);
  assert.equal(scrollBy({ top: 0 }, 30, 5, -9).top, 0);
  assert.equal(scrollBy({ top: 24 }, 30, 5, 99).top, 25);
  assert.deepEqual(visibleRows(rows, 5, { top: 2 }), ['l2', 'l3', 'l4', 'l5', 'l6']);
});

test('logFor picks the recorded file, else the running one, else the last', () => {
  const r = run('ENG-1', {}, 'running');
  assert.equal(logFor(r, 'vs-dev'), undefined === r.record!.steps[0]!.log ? '01-vs-dev.log' : logFor(r, 'vs-dev'));
  const named = run('ENG-1', { logs: ['01-vs-dev.log', '02-vs-qa.log'] });
  for (const s of named.record!.steps) s.log = undefined;
  assert.equal(logFor(named, 'vs-dev'), '01-vs-dev.log');
  assert.equal(logFor(named, undefined), '02-vs-qa.log');
});

test('Runs renders the table, the detail and the labels', async () => {
  const spy = newSpy();
  runsDeps.debounceMs = 1;
  runsDeps.fetchLabels = async () => ['vs-working', 'vs-dev-v1'];
  const r = run('ENG-1412', {}, 'running');
  r.record!.prUrl = 'https://github.com/o/r/pull/1502';
  const data = fakeData({ runs: [r, run('ENG-1399')], agents: agents('ENG-1412'), workflows: [{ name: 'tether-relay-build', triggers: [], steps: ['vs-dev', 'vs-qa'], maxRounds: 3, project: 'p' }] });
  const ui = render(withFakes(spy, data, React.createElement(Runs, { params: {} }), { columns: 110, rows: 40 }));
  await tick(50);
  const f = ui.lastFrame() ?? '';
  assert.match(f, /Runs, newest first/);
  assert.match(f, /ENG-1412/);
  assert.match(f, /tether-relay-build/);
  assert.match(f, /Dev → QA/);
  assert.match(f, /running/);
  assert.match(f, /verified/);
  assert.match(f, /Retries|All good/);
  assert.match(f, /github.com\/o\/r\/pull\/1502/);
  assert.match(f, /labels vs-working vs-dev-v1/);
  assert.ok(!/[\u2014\u2013]/.test(f));
  ui.unmount();
});

test('Runs keys: enter opens the log, c asks to cancel, x cleans, / filters', async () => {
  const spy = newSpy();
  runsDeps.fetchLabels = async () => null;
  const data = fakeData({ runs: [run('ENG-1412', {}, 'running'), run('ENG-1399')], agents: agents('ENG-1412') });
  const ui = render(withFakes(spy, data, React.createElement(Runs, { params: {} }), { columns: 110, rows: 40 }));
  await tick();
  ui.stdin.write('\r');
  await tick();
  assert.deepEqual(spy.pushed[0], { id: 'agents.log', params: { card: 'ENG-1412', dir: '/tmp/runs/ENG-1412/a', step: 'vs-qa', stepLabel: 'QA' } });
  ui.stdin.write('c');
  await tick();
  assert.deepEqual((spy.ran[0] as { args: string[] }).args, ['agents', 'cancel', 'ENG-1412']);
  ui.stdin.write('x');
  await tick();
  assert.deepEqual((spy.ran[1] as { args: string[] }).args, ['agents', 'clean', '--yes']);
  ui.stdin.write('\u001b[B');
  await tick();
  ui.stdin.write('c');
  await tick();
  assert.equal(spy.ran.length, 2);
  assert.match(spy.toasts.join('\n'), /not running/);
  ui.stdin.write('/');
  await tick();
  ui.stdin.write('1399');
  await tick();
  ui.stdin.write('\r');
  await tick();
  const f = ui.lastFrame() ?? '';
  assert.match(f, /ENG-1399/);
  assert.ok(!/ENG-1412  /.test(f.split('\n').slice(0, 8).join('\n')));
  ui.unmount();
});

test('LogView follows a growing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsf-log-'));
  writeFileSync(join(dir, '02-vs-qa.log'), '$ claude -p\nReading the plan.\n');
  const r = run('ENG-1412', { dir }, 'running');
  const spy = newSpy();
  const data = fakeData({ runs: [r], agents: agents('ENG-1412') });
  const ui = render(withFakes(spy, data, React.createElement(LogView, { params: { card: 'ENG-1412', dir, step: 'vs-qa' } }), { columns: 100, rows: 24 }));
  await tick(700);
  let f = ui.lastFrame() ?? '';
  assert.match(f, /02-vs-qa\.log/);
  assert.match(f, /Reading the plan\./);
  assert.match(f, /round 1 of|round 1/);
  appendFileSync(join(dir, '02-vs-qa.log'), 'CI passed on this branch.\n');
  await tick(900);
  f = ui.lastFrame() ?? '';
  assert.match(f, /CI passed on this branch\./);
  ui.stdin.write('1');
  await tick(700);
  assert.match(ui.lastFrame() ?? '', /01-vs-dev\.log/);
  ui.unmount();
});

test('a step line shows its tokens and cost, and nothing without usage', async () => {
  const { stepLine } = await import('../src/tui/screens/runs.ts');
  const step: StepRecord = { step: 'vs-dev', label: 'Dev', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:05:00.000Z', result: 'done', summary: 'did it' };
  const line = (s: StepRecord) => stepLine(s, Date.parse('2026-10-20T10:06:00.000Z')).map((x) => x.text).join('');
  assert.ok(!line(step).includes('est.'));
  assert.match(line({ ...step, usage: { input: 12_300, output: 4100, costUsd: 0.42, model: 'opus' } }), /12\.3k in, 4\.1k out, \$0\.42 est\.  did it$/);
});
