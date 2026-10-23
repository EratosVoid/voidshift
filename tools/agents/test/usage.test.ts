import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWindow, writeWindow, addUsage } from '../src/state.ts';
import { readClaudeToken, refreshWindow, toPercent, windowHold, windowLine, windowStale } from '../src/usage.ts';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const reading = (utilization: number, resetsAt = later(120)) => ({ checkedAt: NOW.toISOString(), utilization, resetsAt });

test('the hold starts at pauseAt, not below it, and never with 0', () => {
  assert.equal(windowHold(reading(90), 90, NOW), later(120));
  assert.equal(windowHold(reading(89), 90, NOW), null);
  assert.equal(windowHold(reading(100), 0, NOW), null);
  assert.equal(windowHold(reading(95, later(-1)), 90, NOW), null, 'the window has reset');
  assert.equal(windowHold(null, 90, NOW), null);
});

test('utilization reads on a 0 to 1 and a 0 to 100 scale', async () => {
  assert.equal(toPercent(0.62), 62);
  assert.equal(toPercent(62), 62);
  assert.equal(toPercent(0), 0);
  for (const utilization of [0.91, 91]) {
    const dir = mkdtempSync(join(tmpdir(), 'vsf-usage-'));
    const fetcher = (async () => new Response(JSON.stringify({ five_hour: { utilization, resets_at: later(60) } }))) as typeof fetch;
    const w = await refreshWindow(dir, fetcher, () => ({ token: 't' }), NOW);
    assert.equal(Math.round(w.utilization!), 91);
    assert.equal(w.resetsAt, later(60));
    assert.deepEqual(readWindow(dir), w);
  }
});

test('a reading is reused within 5 minutes and read again after it resets', () => {
  assert.equal(windowStale(null, NOW), true);
  assert.equal(windowStale(reading(50), new Date(NOW.getTime() + 4 * 60_000)), false);
  assert.equal(windowStale(reading(50), new Date(NOW.getTime() + 5 * 60_000)), true);
  assert.equal(windowStale(reading(50, later(2)), new Date(NOW.getTime() + 3 * 60_000)), true, 'past resetsAt');
});

test('an expired token never calls the fetcher, and the token is never logged', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'vsf-claude-'));
  const creds = (expiresAt: number) => writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-secret', expiresAt } }));
  creds(NOW.getTime() + 60_000);
  assert.deepEqual(readClaudeToken({ platform: 'linux', claudeDir, now: NOW.getTime() }), { token: 'sk-secret' });
  creds(NOW.getTime() - 1);
  const dir = mkdtempSync(join(tmpdir(), 'vsf-usage-'));
  const w = await refreshWindow(dir, (async () => assert.fail('fetched')) as typeof fetch, () => readClaudeToken({ platform: 'linux', claudeDir, now: NOW.getTime() }), NOW);
  assert.match(w.error!, /expired/);
  assert.ok(!JSON.stringify(readWindow(dir)).includes('sk-secret'));
  assert.match(readClaudeToken({ platform: 'linux', claudeDir: join(claudeDir, 'none') }).error ?? '', /no Claude login/);
});

test('a failed read keeps a hold that is still ahead, and drops one that reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsf-usage-'));
  const down = (async () => new Response('', { status: 503 })) as typeof fetch;
  writeWindow(dir, reading(93, later(30)));
  const w = await refreshWindow(dir, down, () => ({ token: 't' }), new Date(NOW.getTime() + 10 * 60_000));
  assert.equal(w.utilization, 93);
  assert.match(w.error!, /503/);
  assert.equal(windowHold(w, 90, new Date(NOW.getTime() + 10 * 60_000)), later(30));
  const after = await refreshWindow(dir, down, () => ({ token: 't' }), new Date(NOW.getTime() + 40 * 60_000));
  assert.equal(after.utilization, undefined);
});

test('the status line shows usage, the hold and a read error', () => {
  assert.match(windowLine(reading(61.6), 90, NOW), /^Window: 5 hour at 62%, resets \d\d:\d\d\.$/);
  assert.match(windowLine(reading(91), 90, NOW), /^Window: held at 91% until \d\d:\d\d, running cards finish\.$/);
  assert.equal(windowLine({ checkedAt: NOW.toISOString(), error: 'no Claude login found' }, 90, NOW), 'Window: could not read the 5 hour window (no Claude login found).');
  assert.equal(windowLine(null, 90, NOW), '');
});

test('a run adds up its steps and lists each model once', () => {
  let total = addUsage(undefined, { input: 10, output: 5, cached: 100, costUsd: 0.5, model: 'opus' });
  total = addUsage(total, { input: 1, output: 1, costUsd: 0.25, model: 'opus' });
  total = addUsage(total, { model: 'gpt-5' });
  assert.deepEqual(total, { input: 11, output: 6, cached: 100, costUsd: 0.75, models: ['opus', 'gpt-5'] });
  assert.deepEqual(addUsage(undefined, { model: 'gpt-5' }), { models: ['gpt-5'] });
});
