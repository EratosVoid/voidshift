import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineArgs, errorTail, parseClaudeJson, runAgent } from '../src/engine.ts';

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

test('both claude argument lists ask for JSON output', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    for (const write of [true, false]) {
      const { args } = engineArgs({ ...base, engine: 'claude', write, platform }, '/o');
      assert.equal(args[args.indexOf('--output-format') + 1], 'json', `${platform} ${write}`);
    }
  }
});

const RESULT = {
  type: 'result',
  is_error: false,
  result: 'All done.\nRESULT: DONE',
  total_cost_usd: 0.4213,
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  modelUsage: {
    'claude-haiku': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
    'claude-opus': { inputTokens: 1200, outputTokens: 3400, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 2000, costUSD: 0.41 },
  },
};

test('parseClaudeJson reads the text, tokens over every model, cost and the main model', () => {
  assert.deepEqual(parseClaudeJson(JSON.stringify(RESULT)), {
    text: 'All done.\nRESULT: DONE',
    isError: false,
    usage: { input: 1300, output: 3450, cached: 52_000, model: 'claude-opus', costUsd: 0.4213 },
  });
  const { modelUsage: _m, ...plain } = RESULT;
  assert.deepEqual(parseClaudeJson(JSON.stringify(plain))!.usage, { input: 1, output: 2, cached: 7, costUsd: 0.4213 });
  assert.equal(parseClaudeJson('RESULT: DONE'), null);
  assert.equal(parseClaudeJson('{"x":1}'), null);
});

// A fake engine on PATH that prints `out` and exits with `code`.
async function fake(engine: 'claude' | 'codex', out: string, code = 0, model?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vsf-engine-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'out'), out);
  writeFileSync(join(bin, engine), `#!/bin/sh\ncat > /dev/null\ncat "${join(dir, 'out')}"\nexit ${code}\n`);
  chmodSync(join(bin, engine), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    const logFile = join(dir, 'step.log');
    const r = await runAgent({ engine, model, cwd: dir, prompt: 'p', write: false, logFile, platform: 'linux' });
    return { r, log: readFileSync(logFile, 'utf8') };
  } finally {
    process.env.PATH = before;
  }
}

test('a claude step returns its text and usage, and logs both as text', async () => {
  const { r, log } = await fake('claude', JSON.stringify(RESULT));
  assert.equal(r.ok, true);
  assert.equal(r.output, 'All done.\nRESULT: DONE');
  assert.equal(r.usage?.costUsd, 0.4213);
  assert.match(log, /All done\.\nRESULT: DONE/);
  assert.match(log, /usage: 1\.3k in, 3\.5k out, 52\.0k cached, \$0\.42 est\., claude-opus/);
  assert.ok(!log.includes('"modelUsage"'), 'no raw JSON in the log');
});

test('plain text from claude is taken as text with no usage', async () => {
  const { r, log } = await fake('claude', 'RESULT: DONE\n');
  assert.equal(r.output, 'RESULT: DONE\n');
  assert.equal(r.usage, undefined);
  assert.match(log, /RESULT: DONE/);
});

test('a claude error with no stderr says why from its result', async () => {
  const { r } = await fake('claude', JSON.stringify({ ...RESULT, is_error: true, result: 'Credit balance is too low' }), 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Credit balance is too low');
  assert.equal(r.usage?.model, 'claude-opus');
});

test('a codex step records only its model', async () => {
  assert.deepEqual((await fake('codex', 'done\n', 0, 'gpt-5')).r.usage, { model: 'gpt-5' });
  assert.equal((await fake('codex', 'done\n')).r.usage, undefined);
});
