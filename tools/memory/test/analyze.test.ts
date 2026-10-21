import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import memory from '../src/index.ts';
import { listNotes, scaffold } from '../src/vault.ts';
import { analyzeVault, diffHomes, hasProblems, indexTargets, missingHookPaths, shellTokens, validateMemoryConfig } from '../src/analyze.ts';
import { recallCommand } from '../src/hooks.ts';

const INDEX = `- [A](work/a.md) - alpha
- [Gone](work/gone.md) - gone
- [Web](https://x.io/page.md) - ignored
`;

test('check finds unindexed notes, broken index links and broken [[links]]', () => {
  const files = new Map([
    ['work/a.md', '---\nname: alpha-note\n---\nSee [[b]] and [[alpha-note]] and [[nope|alias]]. `[[inline]]`\n```\n[[fenced]]\n```'],
    ['work/b.md', 'See [[work/a]] and [[Missing#part]]'],
  ]);
  const r = analyzeVault(files, INDEX);
  assert.equal(r.notes, 2);
  assert.deepEqual(r.unindexed, ['work/b.md']);
  assert.deepEqual(r.brokenIndex, ['work/gone.md']);
  assert.deepEqual(r.brokenLinks, [{ note: 'work/a.md', link: 'nope' }, { note: 'work/b.md', link: 'Missing' }]);
  assert.ok(hasProblems(r));
  assert.ok(!hasProblems(analyzeVault(new Map([['work/a.md', 'hi']]), '- [A](work/a.md) - a')));
});

test('shellTokens undoes recallCommand quoting', () => {
  const cmd = recallCommand(['/opt/my node/bin/node', "/x/it's/vsf.ts"]);
  assert.deepEqual(shellTokens(cmd), ['/opt/my node/bin/node', "/x/it's/vsf.ts", 'memory', 'recall']);
  assert.deepEqual(shellTokens(cmd, 2), ['/opt/my node/bin/node', "/x/it's/vsf.ts"]);
  assert.deepEqual(shellTokens('a "b c" d\\ e'), ['a', 'b c', 'd e']);
});

test('missingHookPaths reports absolute paths that do not exist', () => {
  const exists = (p: string) => p === '/ok/node';
  assert.deepEqual(missingHookPaths('/ok/node /gone/vsf.js memory recall', exists), ['/gone/vsf.js']);
  assert.deepEqual(missingHookPaths('vsf memory recall', exists), []);
  assert.deepEqual(missingHookPaths("'/ok/node' '/ok/node' memory recall", exists), []);
});

test('config validation', () => {
  const o = { isVault: (d: string) => d === '/v', exists: (d: string) => d === '/h' };
  assert.deepEqual(validateMemoryConfig({ vault: '/v', homes: [{ kind: 'claude', dir: '/h' }] }, o), []);
  const bad = validateMemoryConfig({ vault: '/x', homes: [{ kind: 'vim', dir: '/nope' }, 3], extra: 1 }, o);
  assert.equal(bad.length, 5);
  assert.match(bad.join('\n'), /unknown key "extra"/);
  assert.deepEqual(validateMemoryConfig({ vault: 1, homes: 'x' }, o), ['vault must be a folder path', 'homes must be a list of { kind, dir }']);
});

test('config validation rejects "~" and relative paths', () => {
  const o = { isVault: () => true, exists: () => true };
  const r = validateMemoryConfig({ vault: '~/memory', homes: [{ kind: 'claude', dir: '~/.claude' }, { kind: 'codex', dir: 'rel/dir' }] }, o);
  assert.equal(r.length, 3);
  assert.match(r.join('\n'), /absolute path/);
});

test('diffHomes finds removed and added homes', () => {
  const a = { kind: 'claude', dir: '/a' } as const;
  const b = { kind: 'codex', dir: '/b' } as const;
  const c = { kind: 'claude', dir: '/c' } as const;
  assert.deepEqual(diffHomes([a, b], [b, c]), { removed: [a], added: [c] });
  assert.deepEqual(diffHomes([], [a]), { removed: [], added: [a] });
  assert.deepEqual(diffHomes([a], [a]), { removed: [], added: [] });
});

test('indexTargets follows the recall rule', () => {
  const index = [
    '# Index',
    'One line: `- [X](inline.md) - k`',
    '- [My note](work/my note.md) - spaces',
    '- [Dot](./work/dot.md) - dot',
    '* [Star](work/star.md) - not a "- " line',
    '```',
    '- [Fenced](work/fenced.md) - k',
    '```',
    '- `[Code](work/code.md)` [Real](work/real.md) - k',
    '- [Web](https://x.io/p.md) - k',
  ].join('\n');
  assert.deepEqual(indexTargets(index), ['work/my note.md', 'work/dot.md', 'work/real.md']);
});

test('a freshly scaffolded vault passes check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-scaf-'));
  try {
    scaffold(dir);
    const found = analyzeVault(new Map(listNotes(dir).map((p) => [p, readFileSync(join(dir, p), 'utf8')])), readFileSync(join(dir, 'INDEX.md'), 'utf8'));
    assert.ok(!hasProblems(found));
    mkdirSync(join(dir, 'work'));
    writeFileSync(join(dir, 'work', 'my note.md'), 'hi');
    writeFileSync(join(dir, 'INDEX.md'), readFileSync(join(dir, 'INDEX.md'), 'utf8') + '- [My note](work/my note.md) - spaced\n');
    const again = analyzeVault(new Map(listNotes(dir).map((p) => [p, 'hi'])), readFileSync(join(dir, 'INDEX.md'), 'utf8'));
    assert.deepEqual(again.unindexed, []);
    assert.equal(again.notes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listNotes skips dangling symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-link-'));
  try {
    writeFileSync(join(dir, 'a.md'), 'x');
    symlinkSync(join(dir, 'missing.md'), join(dir, 'dangling.md'));
    assert.deepEqual(listNotes(dir), ['a.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config write applies the change to skill and homes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mem-cfg-'));
  try {
    const configDir = join(root, 'cfg');
    const v1 = join(root, 'v1');
    const v2 = join(root, 'v2');
    const h1 = join(root, 'h1');
    const h2 = join(root, 'h2');
    for (const d of [v1, v2, h1, h2]) mkdirSync(d);
    scaffold(v1);
    scaffold(v2);
    assert.deepEqual(memory.config!.write(configDir, { vault: v1, homes: [{ kind: 'claude', dir: h1 }] }), []);
    assert.ok(existsSync(join(h1, 'skills', 'memory')));
    assert.match(readFileSync(join(configDir, 'memory', 'skill', 'SKILL.md'), 'utf8'), new RegExp(v1));
    assert.deepEqual(memory.config!.write(configDir, { vault: v2, homes: [{ kind: 'claude', dir: h2 }] }), []);
    assert.match(readFileSync(join(configDir, 'memory', 'skill', 'SKILL.md'), 'utf8'), new RegExp(v2));
    assert.ok(!existsSync(join(h1, 'skills', 'memory')));
    assert.ok(existsSync(join(h2, 'skills', 'memory')));
    assert.ok(memory.config!.write(configDir, { vault: '~/x', homes: [] }).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
