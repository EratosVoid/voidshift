import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { match, previewContext, recallContext, words } from '../src/recall.ts';
import { scaffold } from '../src/vault.ts';

const INDEX = `# Memory index

- [Relay PRs go into tether-staging](work/relay-base.md) - relay tether pull request base branch staging ci
- [Plexa pricing](work/plexa-pricing.md) - plexa pricing plans
not a note line
`;

test('prompt words skip stopwords and short words', () => {
  assert.deepEqual(words('What did we decide on the Relay base branch?'), ['decide', 'relay', 'base', 'branch']);
});

test('the index line with the most prompt words wins', () => {
  const found = match(INDEX, 'which branch do relay PRs go into');
  assert.deepEqual(found.map((m) => m.path), ['work/relay-base.md']);
  assert.equal(found[0]!.title, 'Relay PRs go into tether-staging');
  assert.deepEqual(match(INDEX, 'hello there'), []);
});

test('recall brings a note once per session', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  scaffold(vault);
  writeFileSync(join(vault, 'INDEX.md'), INDEX);
  mkdirSync(join(vault, 'work'));
  writeFileSync(join(vault, 'work', 'relay-base.md'), 'PRs go into tether-staging.');
  const session = `t${Date.now()}`;
  const first = recallContext(vault, 'relay base branch', session);
  assert.match(first, /--- work\/relay-base.md ---\nPRs go into tether-staging/);
  assert.equal(recallContext(vault, 'relay base branch', session), '');
});

test('scaffold never overwrites an existing vault', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  writeFileSync(join(vault, 'INDEX.md'), INDEX);
  assert.deepEqual(scaffold(vault), ['CONVENTIONS.md']);
});

test('previewContext matches recall for a fresh session and leaves no state', () => {
  const vault = mkdtempSync(join(tmpdir(), 'vault-'));
  writeFileSync(join(vault, 'INDEX.md'), INDEX);
  mkdirSync(join(vault, 'work'));
  writeFileSync(join(vault, 'work', 'relay-base.md'), 'PRs go into tether-staging.');
  const preview = previewContext(vault, 'relay base branch');
  assert.equal(previewContext(vault, 'relay base branch'), preview);
  assert.equal(recallContext(vault, 'relay base branch', `p${Date.now()}`), preview);
  assert.equal(previewContext(vault, 'hello there'), '');
});
