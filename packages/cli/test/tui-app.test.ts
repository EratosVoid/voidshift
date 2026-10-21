import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Shell } from '../src/tui/app.ts';
import { DataContext, emptyState } from '../src/tui/data.ts';
import { fakeData } from './tui-helpers.ts';

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('the shell opens the key help and the palette, and closes them with esc', async () => {
  const data = fakeData({ ...emptyState(['awake']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  assert.match(r.lastFrame()!, /VoidShift/);
  r.stdin.write('?');
  await wait();
  assert.match(r.lastFrame()!, /Keys/);
  r.stdin.write('x');
  await wait();
  assert.doesNotMatch(r.lastFrame()!, /Keys/);
  r.stdin.write(':');
  await wait();
  assert.match(r.lastFrame()!, /: command/);
  r.stdin.write('doctor');
  await wait();
  assert.match(r.lastFrame()!, /doctor \[--json\]/);
  r.stdin.write('\u001b');
  await wait(80);
  assert.doesNotMatch(r.lastFrame()!, /: command/);
  r.unmount();
});

test('enter on a section opens its screen and esc comes back', async () => {
  const data = fakeData({ ...emptyState(['awake']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  r.stdin.write('\r');
  await wait();
  assert.match(r.lastFrame()!, /Awake[\s\S]*(Coming in this release\.|awake is not added)/);
  r.stdin.write('\u001b');
  await wait(80);
  assert.doesNotMatch(r.lastFrame()!, /Coming in this release|awake is not added/);
  r.unmount();
});
