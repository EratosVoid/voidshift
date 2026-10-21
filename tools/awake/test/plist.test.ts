import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programPaths } from '../src/plist.ts';
import { watchdogPlist } from '../src/system.ts';

test('reads absolute program paths from the watchdog plist', () => {
  const plist = watchdogPlist(['/usr/local/bin/node', '/opt/a&b/vsf.ts', 'awake', 'tick'], '/tmp/log');
  assert.deepEqual(programPaths(plist), ['/usr/local/bin/node', '/opt/a&b/vsf.ts']);
});

test('no ProgramArguments means no paths', () => {
  assert.deepEqual(programPaths('<plist></plist>'), []);
});
