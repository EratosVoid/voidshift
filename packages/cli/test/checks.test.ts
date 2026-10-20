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

test('non-macOS fails', () => {
  const checks = baseChecks('win32', 'v24.0.0', fake({ git: 'git 2', gh: '', claude: '2.1' }));
  assert.equal(checks.find((c) => c.name === 'macOS')?.status, 'fail');
});
