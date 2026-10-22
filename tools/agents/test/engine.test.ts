import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineArgs } from '../src/engine.ts';

const base = { cwd: '/w', prompt: '', logFile: '/l', vault: '/Users/a/memory' };

test('claude may write notes into the vault, even on read steps', () => {
  const { args } = engineArgs({ ...base, engine: 'claude', write: false }, '/o');
  const tools = args[args.indexOf('--allowedTools') + 1]!;
  assert.ok(tools.includes('Edit(//Users/a/memory/**)'));
  assert.ok(!tools.includes('Write(//'));
  assert.ok(!tools.split(',').includes('Write'));
  assert.equal(args[args.indexOf('--add-dir') + 1], '/Users/a/memory');
});

test('codex gets the vault only on write steps', () => {
  assert.ok(engineArgs({ ...base, engine: 'codex', write: true }, '/o').args.includes('--add-dir'));
  assert.ok(!engineArgs({ ...base, engine: 'codex', write: false }, '/o').args.includes('--add-dir'));
});
