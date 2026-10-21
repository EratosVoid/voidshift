import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Shell } from '../src/tui/app.ts';
import { DataContext, emptyState, type ProjectItem, type RunItem } from '../src/tui/data.ts';
import { Home } from '../src/tui/home.ts';
import { folderStamp, stamp, stampDate } from '../src/tui/format.ts';
import { splitKeys } from '../src/tui/keys.ts';
import { startedText } from '../src/tui/screens/runs.ts';
import { wrapLines, bottomTop, visibleRows } from '../src/tui/screens/log.ts';
import { projectColumns, projectRows } from '../src/tui/screens/projects.ts';
import { fitColumn, layoutFooter, Table } from '../src/tui/widgets.ts';
import { fakeData, newSpy, withFakes } from './tui-helpers.ts';

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('a run folder stamp is shown as local "Mon D HH:MM"', () => {
  const d = stampDate('2026-10-21T03-31-12-345Z');
  assert.equal(d.toISOString(), '2026-10-21T03:31:12.345Z');
  assert.equal(folderStamp('2026-10-21T03-31-12-345Z'), stamp(d));
  assert.match(folderStamp('2026-10-21T03-31-12-345Z'), /^(Oct 20|Oct 21) \d\d:\d\d$/);
  assert.equal(folderStamp('not a date'), '?');
  const run: RunItem = { card: 'ENG-1', stamp: '2026-10-21T03-31-12-345Z', dir: '/x', logs: [] };
  assert.doesNotMatch(startedText(run), /T|…|-345/);
  assert.equal(startedText(run), stamp(d));
});

const hints = [
  { key: 'n', label: 'new' },
  { key: 'e', label: 'edit' },
  { key: 'R', label: 'rename' },
  { key: 'd', label: 'delete' },
  { key: 'esc', label: 'back' },
];

test('footer: hints and command share a line when they fit', () => {
  const l = layoutFooter(hints, '= vsf agents cancel ENG-1', 120);
  assert.equal(l.inline, true);
  assert.equal(l.rows.length, 1);
  assert.equal(l.command, '= vsf agents cancel ENG-1');
});

test('footer: hints wrap without ellipsis and the command gets its own line', () => {
  const command = '= vsf agents cancel ENG-1407';
  const l = layoutFooter(hints, command, 30);
  assert.equal(l.inline, false);
  assert.ok(l.rows.length > 1);
  assert.deepEqual(l.rows.flat(), hints);
  for (const row of l.rows) assert.ok(row.reduce((n, x) => n + x.key.length + x.label.length + 5, -2) <= 30);
  assert.equal(l.command, command);
  const cut = layoutFooter(hints, command, 20);
  assert.equal(cut.command!.length, 20);
  assert.ok(cut.command!.endsWith('…'));
  assert.deepEqual(cut.rows.flat(), hints);
});

test('footer: no command means plain hints', () => {
  const l = layoutFooter(hints, undefined, 20);
  assert.equal(l.command, null);
  assert.deepEqual(l.rows.flat(), hints);
});

test('table columns keep two spaces before the next column', () => {
  assert.equal(fitColumn('short', 10), 'short     ');
  const cut = fitColumn('~/me/eratosvoid/voidshift', 16);
  assert.equal(cut.length, 16);
  assert.match(cut, /…\s{2}$/);
  assert.equal(fitColumn('exactly-14-chr', 16), 'exactly-14-chr  ');
  const projects: ProjectItem[] = [{ name: 'voidshift', path: `${process.env.HOME}/me/eratosvoid/voidshift/with/a/very/long/path/inside`, base: 'main', usedBy: [] }];
  const columns = projectColumns(70, projects);
  const r = render(React.createElement(Table, { columns, rows: projectRows(projects), marker: false }));
  const line = r.lastFrame()!.split('\n')[1]!;
  assert.match(line, /…\s{2,}PRs into main/);
  r.unmount();
});

test('log lines wrap at spaces, and only a too-long word is cut', () => {
  assert.deepEqual(wrapLines(['the quick brown fox jumps over the lazy dog'], 16), ['the quick brown', 'fox jumps over', 'the lazy dog']);
  assert.deepEqual(wrapLines(['a'.repeat(20), '', 'ok'], 8), ['aaaaaaaa', 'aaaaaaaa', 'aaaa', '', 'ok']);
  for (const row of wrapLines(['see /very/long/path/that/never/breaks now'], 12)) assert.ok(row.length <= 12);
  const rows = wrapLines(['see abcdefghijklmnopqrstuvwxyz now'], 10);
  assert.deepEqual(rows, ['see', 'abcdefghij', 'klmnopqrst', 'uvwxyz now']);
  for (const row of wrapLines(['word '.repeat(30)], 20)) assert.ok(row.length <= 20);
  // Scroll math runs on the wrapped rows.
  const wrapped = wrapLines(['word '.repeat(30)], 20);
  assert.equal(bottomTop(wrapped.length, 3), wrapped.length - 3);
  assert.equal(visibleRows(wrapped, 3, { top: null }).length, 3);
});

test('a chunk is split into single keys', () => {
  assert.deepEqual(splitKeys('\u001b[C\u001b[C'), ['\u001b[C', '\u001b[C']);
  assert.deepEqual(splitKeys('\u001b[A\u001b[B\u001bOA'), ['\u001b[A', '\u001b[B', '\u001bOA']);
  assert.deepEqual(splitKeys('\r\r'), ['\r', '\r']);
  assert.deepEqual(splitKeys('j\tk\u001b'), ['j', '\t', 'k', '\u001b']);
  assert.deepEqual(splitKeys('\u001b'), ['\u001b']);
  assert.deepEqual(splitKeys('\u001b\u001b'), ['\u001b', '\u001b']);
  assert.deepEqual(splitKeys('\u001b[1;5C'), ['\u001b[1;5C']);
  assert.deepEqual(splitKeys('a😀b'), ['a', '😀', 'b']);
  assert.deepEqual(splitKeys('\u001b[200~pasted text\u001b[201~'), ['\u001b[200~pasted text\u001b[201~']);
  assert.deepEqual(splitKeys(''), []);
});

const openAgents = async () => {
  const data = fakeData({ ...emptyState(['agents']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  r.stdin.write('\r');
  await wait();
  assert.match(r.lastFrame()!, /Agents › Runs/);
  return r;
};

test('two right arrows in one write move two tabs', async () => {
  const r = await openAgents();
  r.stdin.write('\u001b[C\u001b[C');
  await wait(100);
  assert.match(r.lastFrame()!, /Agents › Projects/);
  r.stdin.write('\u001b[D\u001b[D');
  await wait(100);
  assert.match(r.lastFrame()!, /Agents › Runs/);
  r.unmount();
});

test('two enters in one write are both handled', async () => {
  const data = fakeData({ ...emptyState(['agents']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  r.stdin.write('\r\r');
  await wait(100);
  assert.match(r.lastFrame()!, /Agents › Runs/);
  r.unmount();
});

test('typing into the palette still arrives as one chunk', async () => {
  const data = fakeData({ ...emptyState(['agents']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  r.stdin.write(':');
  await wait();
  r.stdin.write('doctor');
  await wait(100);
  assert.match(r.lastFrame()!, /doctor \[--json\]/);
  r.unmount();
});

test('Home says Checking before checks load and Checks skipped when skipped', () => {
  const spy = newSpy();
  const loading = render(withFakes(spy, fakeData({ ...emptyState(['agents']), loaded: true, checks: null, checksAt: null }), React.createElement(Home)));
  assert.match(loading.lastFrame()!, /Checking…/);
  assert.doesNotMatch(loading.lastFrame()!, /0 ok/);
  loading.unmount();
  const prev = process.env.VSF_TUI_SKIP_CHECKS;
  process.env.VSF_TUI_SKIP_CHECKS = '1';
  try {
    const skipped = render(withFakes(spy, fakeData({ ...emptyState(['agents']), loaded: true, checks: [], checksAt: 1 }), React.createElement(Home)));
    assert.match(skipped.lastFrame()!, /Checks skipped/);
    assert.doesNotMatch(skipped.lastFrame()!, /0 ok/);
    skipped.unmount();
  } finally {
    if (prev === undefined) delete process.env.VSF_TUI_SKIP_CHECKS;
    else process.env.VSF_TUI_SKIP_CHECKS = prev;
  }
});

test('layoutFooter wraps long hints even without a command', () => {
  const hints = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: 'some label' }));
  const layout = layoutFooter(hints, undefined, 60);
  assert.ok(layout.rows.length > 1);
  assert.equal(layout.command, null);
  assert.equal(layout.rows.flat().length, 12);
});
