import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const main = new URL('../src/main.ts', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'vsf-test-'));

// stdin is a pipe here, so there is never a terminal.
const vsf = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', env: { ...process.env, VOIDSHIFT_HOME: home } });

test('unknown and inherited names are unknown commands', () => {
  for (const name of ['nope', 'constructor', 'toString']) {
    const r = vsf(name);
    assert.equal(r.status, 2, name);
    assert.equal(r.stderr, `unknown command: ${name}. Run vsf help.\n`);
  }
  assert.equal(vsf('help', 'constructor').status, 2);
  assert.equal(vsf('constructor', '--help').status, 2);
});

test('config on an unknown tool exits 2', () => {
  assert.equal(vsf('config', 'nope').status, 2);
  assert.equal(vsf('config', 'get', 'nope.x').status, 2);
});

test('prompting commands refuse without a terminal', () => {
  for (const args of [['setup'], ['setup', 'awake'], ['add', 'awake'], ['remove', 'awake']]) {
    const r = vsf(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^vsf \w+ needs a terminal to ask its questions\..*\n$/);
  }
  assert.match(vsf('setup').stderr, /vsf setup --defaults/);
});

test('config edit refuses without a terminal', () => {
  const r = vsf('config', 'edit');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a terminal/);
});

test('config usage documents the -- form', () => {
  assert.match(vsf('config', '--help').stdout, /KEY -- -5/);
});
