import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, validateConfig, writeConfig } from '../src/config.ts';

test('valid values pass', () => {
  assert.deepEqual(validateConfig({ battery: 30, heat: false, revertOnReboot: true }), []);
});

test('bad values and unknown keys are reported', () => {
  assert.equal(validateConfig({ battery: 4 }).length, 1);
  assert.equal(validateConfig({ battery: 96 }).length, 1);
  assert.equal(validateConfig({ battery: 20.5 }).length, 1);
  assert.equal(validateConfig({ battery: '20' }).length, 1);
  assert.equal(validateConfig({ heat: 'no' }).length, 1);
  assert.equal(validateConfig({ revertOnReboot: 1 }).length, 1);
  assert.equal(validateConfig({ nope: true }).length, 1);
});

test('write merges into saved state and read returns settings only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awake-cfg-'));
  try {
    assert.deepEqual(readConfig(dir), { battery: 20, heat: true, revertOnReboot: true });
    assert.deepEqual(writeConfig(dir, { battery: 35, heat: false }), []);
    assert.deepEqual(readConfig(dir), { battery: 35, heat: false, revertOnReboot: true });
    assert.equal(writeConfig(dir, { battery: 1 }).length, 1);
    assert.equal(readConfig(dir).battery, 35);
    // A key missing from the written value resets to its default.
    assert.deepEqual(writeConfig(dir, { heat: false }), []);
    assert.deepEqual(readConfig(dir), { battery: 20, heat: false, revertOnReboot: true });
    assert.deepEqual(writeConfig(dir, {}), []);
    assert.deepEqual(readConfig(dir), { battery: 20, heat: true, revertOnReboot: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
