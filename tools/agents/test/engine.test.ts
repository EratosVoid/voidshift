import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineArgs, errorTail } from '../src/engine.ts';

const base = { cwd: '/w', prompt: '', logFile: '/l', vault: '/Users/a/memory' };

test('claude may write notes into the vault, even on read steps', () => {
  const { args } = engineArgs({ ...base, engine: 'claude', write: false, platform: 'darwin' }, '/o');
  const tools = args[args.indexOf('--allowedTools') + 1]!;
  assert.ok(tools.includes('Edit(//Users/a/memory/**)'));
  assert.ok(!tools.includes('Write(//'));
  assert.ok(!tools.split(',').includes('Write'));
  assert.equal(args[args.indexOf('--add-dir') + 1], '/Users/a/memory');
});

test('codex gets the vault only on write steps', () => {
  assert.ok(engineArgs({ ...base, engine: 'codex', write: true, platform: 'darwin' }, '/o').args.includes('--add-dir'));
  assert.ok(!engineArgs({ ...base, engine: 'codex', write: false, platform: 'darwin' }, '/o').args.includes('--add-dir'));
});

test('on Linux claude skips permissions on every step, with no allowlist', () => {
  for (const write of [true, false]) {
    const { args } = engineArgs({ ...base, engine: 'claude', write, model: 'opus', settingsFile: '/s.json', platform: 'linux' }, '/o');
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--allowedTools'));
    assert.ok(!args.includes('--permission-mode'));
    assert.equal(args[args.indexOf('--add-dir') + 1], '/Users/a/memory');
    assert.equal(args[args.indexOf('--model') + 1], 'opus');
    assert.equal(args[args.indexOf('--settings') + 1], '/s.json');
  }
});

test('on Linux codex bypasses approvals and the sandbox', () => {
  for (const write of [true, false]) {
    const { args } = engineArgs({ ...base, engine: 'codex', write, platform: 'linux' }, '/o');
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('-s'));
    assert.equal(args.at(-1), '-');
  }
});

test('macOS keeps the allowlist and the sandbox', () => {
  const claude = engineArgs({ ...base, engine: 'claude', write: true, platform: 'darwin' }, '/o').args;
  assert.ok(claude.includes('--allowedTools'));
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!claude.includes('--dangerously-skip-permissions'));
  const codex = engineArgs({ ...base, engine: 'codex', write: false, platform: 'darwin' }, '/o').args;
  assert.equal(codex[codex.indexOf('-s') + 1], 'read-only');
});

test('errorTail keeps the last stderr lines, capped at 300 characters', () => {
  assert.equal(errorTail('warming up\n\nError: bash: rg: not found\n'), 'warming up Error: bash: rg: not found');
  assert.equal(errorTail(''), '');
  const long = errorTail(`first\n${'x'.repeat(255)}\n${'y'.repeat(40)}\n`);
  assert.equal(long, `${'x'.repeat(255)} ${'y'.repeat(40)}`);
  assert.equal(errorTail('z'.repeat(400)).length, 300);
});
