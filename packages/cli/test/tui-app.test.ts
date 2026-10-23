import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Shell } from '../src/tui/app.ts';
import { DataContext, emptyState } from '../src/tui/data.ts';
import { fakeData, frameUntil } from './tui-helpers.ts';

const shows = (re: RegExp) => (f: string) => re.test(f);
const hides = (re: RegExp) => (f: string) => !re.test(f);

test('the shell opens the key help and the palette, and closes them with esc', async () => {
  const data = fakeData({ ...emptyState(['awake']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  try {
    assert.match(r.lastFrame()!, /VoidShift/);
    r.stdin.write('?');
    await frameUntil(r, shows(/Keys/));
    r.stdin.write('x');
    await frameUntil(r, hides(/Keys/));
    r.stdin.write(':');
    await frameUntil(r, shows(/: command/));
    r.stdin.write('doctor');
    await frameUntil(r, shows(/doctor \[--json\]/));
    r.stdin.write('\u001b');
    await frameUntil(r, hides(/: command/));
  } finally {
    r.unmount();
  }
});

test('enter on a section opens its screen and esc comes back', async () => {
  const data = fakeData({ ...emptyState(['awake']), loaded: true, checks: [] });
  const r = render(React.createElement(DataContext.Provider, { value: data }, React.createElement(Shell)));
  try {
    r.stdin.write('\r');
    await frameUntil(r, shows(/Awake[\s\S]*(Coming in this release\.|awake is not added)/));
    r.stdin.write('\u001b');
    await frameUntil(r, hides(/Coming in this release|awake is not added/));
  } finally {
    r.unmount();
  }
});
