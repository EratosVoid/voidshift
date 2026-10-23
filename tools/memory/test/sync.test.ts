import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflictPath, describeSync, isStale, syncVault, writeLastSync } from '../src/sync.ts';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A bare remote with a seeded vault, and two machines that cloned it.
function machines() {
  const root = mkdtempSync(join(tmpdir(), 'vsf-sync-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const clone = (name: string) => {
    const dir = join(root, name);
    git(root, 'clone', '-q', remote, dir);
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name}@example.com`);
    git(dir, 'checkout', '-q', '-B', 'main');
    return dir;
  };
  const a = clone('a');
  writeFileSync(join(a, 'INDEX.md'), '# Memory index\n');
  mkdirSync(join(a, 'devvoid'));
  writeFileSync(join(a, 'devvoid', 'note.md'), 'first\n');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'seed');
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = clone('b');
  return { root, a, b };
}

test('a note written on one machine reaches the other', () => {
  const { a, b } = machines();
  writeFileSync(join(a, 'devvoid', 'new.md'), 'from a\n');
  const ra = syncVault(a);
  assert.deepEqual([ra.committed, ra.pushed, ra.conflicts], [true, true, []]);
  const rb = syncVault(b);
  assert.equal(rb.pulled, 1);
  assert.equal(readFileSync(join(b, 'devvoid', 'new.md'), 'utf8'), 'from a\n');
  assert.equal(syncVault(b).pushed, false, 'nothing left to push');
  assert.equal(describeSync(syncVault(a)), 'Already in sync.');
});

test('a note changed on both sides keeps the remote copy and saves this machine copy beside it', () => {
  const { a, b } = machines();
  writeFileSync(join(a, 'devvoid', 'note.md'), 'a wrote this\n');
  syncVault(a);
  writeFileSync(join(b, 'devvoid', 'note.md'), 'b wrote this\n  with an indented line\n');
  const now = new Date('2026-10-23T03:30:00Z');
  const rb = syncVault(b, now);
  assert.equal(rb.conflicts.length, 1);
  assert.equal(readFileSync(join(b, 'devvoid', 'note.md'), 'utf8'), 'a wrote this\n', 'remote version kept');
  assert.equal(readFileSync(join(b, rb.conflicts[0]!), 'utf8'), 'b wrote this\n  with an indented line\n', 'local copy saved byte for byte');
  assert.match(rb.conflicts[0]!, /^devvoid\/note\.conflict-[a-z0-9-]+-202610230330\.md$/);
  assert.equal(rb.pushed, true);
  assert.equal(git(b, 'status', '--porcelain'), '', 'no rebase left behind');
  syncVault(a);
  assert.ok(existsSync(join(a, rb.conflicts[0]!)), 'the saved copy reaches the other machine too');
});

test('a note deleted on the remote but edited here is saved, not lost', () => {
  const { a, b } = machines();
  rmSync(join(a, 'devvoid', 'note.md'));
  syncVault(a);
  writeFileSync(join(b, 'devvoid', 'note.md'), 'edited on b\n');
  const rb = syncVault(b);
  assert.equal(rb.conflicts.length, 1);
  assert.ok(!existsSync(join(b, 'devvoid', 'note.md')));
  assert.equal(readFileSync(join(b, rb.conflicts[0]!), 'utf8'), 'edited on b\n');
});

test('a vault without git or without a remote is left alone', () => {
  const plain = mkdtempSync(join(tmpdir(), 'vsf-plain-'));
  assert.match(syncVault(plain).skipped!, /not a git repository/);
  git(plain, 'init', '-q', '-b', 'main');
  assert.match(syncVault(plain).skipped!, /no remote/);
  assert.deepEqual(readdirSync(plain).sort(), ['.git']);
});

test('conflict copies sit beside the note with the machine and minute', () => {
  assert.equal(conflictPath('tether/a.md', 'vps', new Date('2026-10-23T03:30:59Z')), 'tether/a.conflict-vps-202610230330.md');
  assert.equal(conflictPath('NOTES', 'mac', new Date('2026-10-23T03:30:00Z')), 'NOTES.conflict-mac-202610230330');
});

test('staleness follows the last sync time', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-cfg-'));
  assert.equal(isStale(configDir, 10), true, 'never synced');
  writeLastSync(configDir, true);
  assert.equal(isStale(configDir, 10), false);
  assert.equal(isStale(configDir, 10, Date.now() + 11 * 60_000), true);
});

test('a deleted note stays deleted on the next sync', () => {
  const { a, b } = machines();
  rmSync(join(a, 'devvoid', 'note.md'));
  syncVault(a);
  writeFileSync(join(b, 'devvoid', 'note.md'), 'edited on b\n');
  syncVault(b);
  syncVault(b);
  syncVault(a);
  assert.ok(!existsSync(join(a, 'devvoid', 'note.md')), 'not resurrected');
});
