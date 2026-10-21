import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ours, listRuns, runsDir } from '../src/state.ts';

test('ours is false for a live pid that is not our runner', () => {
  const child = spawn('sleep', ['5'], { stdio: 'ignore' });
  try {
    assert.equal(ours(child.pid!), false);
  } finally {
    child.kill();
  }
});

test('ours is false for a dead pid and true for a runner command line', () => {
  assert.equal(ours(999999999), false);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'agents', 'run'], { stdio: 'ignore' });
  try {
    assert.equal(ours(child.pid!), true);
  } finally {
    child.kill();
  }
});

test('listRuns skips files at both levels', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-state-'));
  const root = runsDir(configDir);
  mkdirSync(join(root, 'ENG-1', '2026-01-01T00-00-00-000Z'), { recursive: true });
  writeFileSync(join(root, '.DS_Store'), '');
  writeFileSync(join(root, 'ENG-1', '.DS_Store'), '');
  const runs = listRuns(configDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.card, 'ENG-1');
  assert.equal(listRuns(configDir, 'ENG-1').length, 1);
});
