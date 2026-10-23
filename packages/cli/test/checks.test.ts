import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLeast, baseChecks, type Run } from '../src/checks.ts';

const fake = (installed: Record<string, string>): Run => (cmd) =>
  cmd in installed ? { ok: true, stdout: installed[cmd] ?? '' } : { ok: false, stdout: '' };

test('atLeast compares dotted versions', () => {
  assert.equal(atLeast('v22.18.0', '22.18'), true);
  assert.equal(atLeast('v24.1.0', '22.18'), true);
  assert.equal(atLeast('v22.17.9', '22.18'), false);
  assert.equal(atLeast('v20.20.2', '22.18'), false);
});

test('a ready Mac passes every check', () => {
  const checks = baseChecks('darwin', 'v24.0.0', fake({ git: 'git 2', gh: '', claude: '2.1', codex: '0.1' }));
  assert.ok(checks.every((c) => c.status === 'ok'));
});

test('no agent CLI is a failure, one is enough', () => {
  const none = baseChecks('darwin', 'v24.0.0', fake({ git: 'git 2', gh: '' }));
  assert.ok(none.some((c) => c.name === 'Agent' && c.status === 'fail'));
  const codexOnly = baseChecks('darwin', 'v24.0.0', fake({ git: 'git 2', gh: '', codex: '0.1' }));
  assert.ok(!codexOnly.some((c) => c.status === 'fail'));
});

test('Linux is supported, Windows is not', () => {
  const linux = baseChecks('linux', 'v24.0.0', fake({ git: 'git 2', gh: '', claude: '2.1', codex: '0.1' }));
  assert.ok(linux.every((c) => c.status === 'ok'));
  const windows = baseChecks('win32', 'v24.0.0', fake({ git: 'git 2', gh: '', claude: '2.1' }));
  assert.equal(windows.find((c) => c.name === 'platform')?.status, 'fail');
});

test('one agent CLI installed means the other is not checked at all', () => {
  const claude = baseChecks('darwin', 'v24.0.0', fake({ git: 'git 2', gh: '', claude: '2.1' }));
  assert.ok(!claude.some((c) => c.name === 'Codex CLI'));
  assert.ok(claude.some((c) => c.name === 'Claude Code' && c.status === 'ok'));
  const codex = baseChecks('darwin', 'v24.0.0', fake({ git: 'git 2', gh: '', codex: '0.1' }));
  assert.ok(!codex.some((c) => c.name === 'Claude Code'));
  const none = baseChecks('darwin', 'v24.0.0', fake({ git: 'git 2', gh: '' }));
  assert.ok(none.some((c) => c.name === 'Codex CLI') && none.some((c) => c.name === 'Claude Code'));
});
