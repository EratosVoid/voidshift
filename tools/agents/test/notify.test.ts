import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, writeAgentsConfig } from '../src/config.ts';
import { changePaused } from '../src/control.ts';
import { addWebhook, dropWebhook, looksLikeWebhook, moveWebhook, notifyRun, postDiscord, readNotifyState, removeWebhook, runMessage, sendSummary, slug, webhookFor } from '../src/notify.ts';
import { readSecret, storeSecret } from '../src/secrets.ts';
import { runsDir, writeRun, type RunRecord } from '../src/state.ts';

const GLOBAL = 'https://discord.com/api/webhooks/1/global';
const OWN = 'https://discord.com/api/webhooks/2/own-hook';

function scratch(workflows: string[] = ['build']) {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-notify-'));
  const flow = { triggers: [], steps: ['vs-qa' as const], maxRounds: 1, project: 'p' };
  writeAgentsConfig(configDir, { ...structuredClone(DEFAULTS), workflows: Object.fromEntries(workflows.map((w) => [w, flow])) });
  const logs: string[] = [];
  return { configDir, logs, log: (l: string) => void logs.push(l) };
}

// A fetch that records each post and answers with this status.
function recorder(status = 204) {
  const posts: { url: string; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(init.body as string) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { posts, fetcher };
}

const linux = 'linux' as const;

test('a run ping names the card, the workflow and a link, and parses no mentions', async () => {
  const { configDir, logs, log } = scratch();
  storeSecret(configDir, 'discord', GLOBAL, linux);
  const { posts, fetcher } = recorder();
  await notifyRun(configDir, { kind: 'ready', card: 'ORG-1', title: '@everyone hi', workflow: 'build', url: 'https://card', prUrl: 'https://pr' }, log, fetcher, linux);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, GLOBAL);
  assert.deepEqual(posts[0]!.body.allowed_mentions, { parse: [] });
  assert.equal(posts[0]!.body.content, '**PR ready** ORG-1 @everyone hi, workflow build\nhttps://pr');
  assert.deepEqual(logs, []);
});

test('a parked ping carries the reason, cut short; a scheduled run has no link', () => {
  const text = runMessage({ kind: 'parked', card: 'BRIEF-1', title: 'Brief', workflow: 'brief', reason: 'x'.repeat(400) });
  const [first, second] = text.split('\n');
  assert.equal(first, '**Parked** BRIEF-1 Brief, workflow brief');
  assert.equal(second, 'x'.repeat(300));
  assert.match(runMessage({ kind: 'failed', card: 'A-1', title: 'T', workflow: 'w', url: 'https://card', reason: 'boom' }), /^\*\*Failed\*\* A-1 T, workflow w\nhttps:\/\/card\nboom$/);
});

test('a dead webhook and a hung network are logged and never throw', async () => {
  const { configDir, logs, log } = scratch();
  storeSecret(configDir, 'discord', GLOBAL, linux);
  const rejects = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  await notifyRun(configDir, { kind: 'parked', card: 'A-1', title: 'T', workflow: 'build' }, log, rejects, linux);
  assert.match(logs[0]!, /^discord: could not reach Discord/);
  const hangs = (() => new Promise(() => {})) as unknown as typeof fetch;
  const started = Date.now();
  assert.match((await postDiscord(GLOBAL, 'hi', hangs, 50))!, /no answer from Discord/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await postDiscord(GLOBAL, 'hi', recorder(404).fetcher), 'Discord answered 404');
});

test('a workflow webhook wins over the global one; other hosts are refused', () => {
  const { configDir } = scratch(['Build It']);
  assert.equal(webhookFor(configDir, 'Build It', linux), null);
  storeSecret(configDir, 'discord', GLOBAL, linux);
  assert.equal(webhookFor(configDir, 'Build It', linux), GLOBAL);
  storeSecret(configDir, 'discord-build-it', OWN, linux);
  assert.equal(webhookFor(configDir, 'Build It', linux), OWN);
  assert.equal(webhookFor(configDir, undefined, linux), GLOBAL);
  assert.ok(looksLikeWebhook('https://canary.discord.com/api/webhooks/9/a_b-c'));
  assert.ok(!looksLikeWebhook('https://evil.com/api/webhooks/1/x'));
  assert.ok(!looksLikeWebhook('http://discord.com/api/webhooks/1/x'));
  assert.ok(!looksLikeWebhook('https://discord.com/api/webhooks/abc/x'));
});

test('slugs: one dash per run of other characters; empty and shared slugs are refused', async () => {
  assert.equal(slug('Foo_Bar 2'), 'foo-bar-2');
  assert.equal(slug('--!!--'), '');
  const { configDir, logs, log } = scratch(['Foo Bar', 'foo-bar', '!!']);
  const { posts, fetcher } = recorder();
  assert.equal(await addWebhook(configDir, OWN, 'Foo Bar', log, fetcher, linux), false);
  assert.match(logs.at(-1)!, /would share a webhook/);
  assert.equal(await addWebhook(configDir, OWN, '!!', log, fetcher, linux), false);
  assert.match(logs.at(-1)!, /no letters or digits/);
  assert.equal(posts.length, 0);
});

test('addWebhook stores only after the test post went through; removeWebhook clears it', async () => {
  const { configDir, logs, log } = scratch();
  assert.equal(await addWebhook(configDir, GLOBAL, undefined, log, recorder(401).fetcher, linux), false);
  assert.equal(readSecret(configDir, 'discord', linux), null);
  assert.match(logs.at(-1)!, /Nothing was stored/);
  assert.equal(await addWebhook(configDir, 'https://example.com/x', undefined, log, recorder().fetcher, linux), false);
  const { posts, fetcher } = recorder();
  assert.equal(await addWebhook(configDir, OWN, 'build', log, fetcher, linux), true);
  assert.equal(posts.length, 1);
  assert.equal(readSecret(configDir, 'discord-build', linux), OWN);
  assert.equal(removeWebhook(configDir, 'build', log, linux), true);
  assert.equal(readSecret(configDir, 'discord-build', linux), null);
  assert.equal(removeWebhook(configDir, 'build', log, linux), true);
  assert.equal(logs.at(-1), 'No webhook set.');
});

test('moveWebhook carries the override to the new name, and refuses a name another workflow shares', () => {
  const { configDir } = scratch(['build', 'Ship It']);
  storeSecret(configDir, 'discord-build', OWN, linux);
  assert.match(moveWebhook(configDir, 'build', 'ship_it', linux)!, /Workflow Ship It would share/);
  assert.equal(readSecret(configDir, 'discord-build', linux), OWN);
  assert.equal(moveWebhook(configDir, 'build', 'make', linux), null);
  assert.equal(readSecret(configDir, 'discord-build', linux), null);
  assert.equal(readSecret(configDir, 'discord-make', linux), OWN);
  dropWebhook(configDir, 'make', linux);
  assert.equal(readSecret(configDir, 'discord-make', linux), null);
});

function endedRun(configDir: string, card: string, outcome: RunRecord['outcome'], endedAt: string, extra: Partial<RunRecord> = {}) {
  const dir = join(runsDir(configDir), card, endedAt.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeRun(dir, { card, title: `Title ${card}`, workflow: 'build', trigger: 'go', steps: [], outcome, startedAt: endedAt, endedAt, ...extra });
}

test('the daily summary goes out once a day after 09:00, while paused too, and two passes together send once', async () => {
  const { configDir, logs, log } = scratch();
  storeSecret(configDir, 'discord', GLOBAL, linux);
  const morning = new Date(2026, 9, 23, 8, 59);
  const later = new Date(2026, 9, 23, 9, 5);
  endedRun(configDir, 'A-1', 'verified', new Date(2026, 9, 23, 2).toISOString(), { prUrl: 'https://pr/1' });
  endedRun(configDir, 'A-2', 'parked', new Date(2026, 9, 23, 3).toISOString(), { reason: 'No plan.' });
  endedRun(configDir, 'A-3', 'verified', new Date(2026, 9, 20).toISOString());
  const { posts, fetcher } = recorder();
  await sendSummary(configDir, true, log, morning, fetcher, linux);
  assert.equal(posts.length, 0);
  await Promise.all([sendSummary(configDir, true, log, later, fetcher, linux), sendSummary(configDir, true, log, later, fetcher, linux)]);
  assert.equal(posts.length, 1);
  const text = posts[0]!.body.content as string;
  assert.match(text, /^\*\*Daily summary\*\* 1 parked, 1 verified|^\*\*Daily summary\*\* 1 verified, 1 parked/);
  assert.match(text, /Runner paused/);
  assert.match(text, /A-1 https:\/\/pr\/1/);
  assert.match(text, /A-2 Title A-2: No plan\./);
  assert.doesNotMatch(text, /A-3/);
  await sendSummary(configDir, false, log, new Date(2026, 9, 23, 18), fetcher, linux);
  assert.equal(posts.length, 1);
  // The next day covers only what ended since; with nothing new it records the day and posts nothing.
  await sendSummary(configDir, false, log, new Date(2026, 9, 24, 10), fetcher, linux);
  assert.equal(posts.length, 1);
  assert.equal(readNotifyState(configDir).summaryDay, '2026-10-24');
  assert.deepEqual(logs, []);
});

test('no webhook means no summary and no state written', async () => {
  const { configDir, log } = scratch();
  await sendSummary(configDir, false, log, new Date(2026, 9, 23, 10), recorder().fetcher, linux);
  assert.deepEqual(readNotifyState(configDir), {});
});

test('pause and resume ping only when the state changes', async () => {
  const { configDir, log } = scratch();
  storeSecret(configDir, 'discord', GLOBAL, linux);
  const { posts, fetcher } = recorder();
  const ctx = { configDir, log };
  await changePaused(ctx, false, 'by start', fetcher, linux);
  await changePaused(ctx, true, 'by hand', fetcher, linux);
  await changePaused(ctx, true, 'by hand', fetcher, linux);
  await changePaused(ctx, false, 'by hand', fetcher, linux);
  assert.deepEqual(posts.map((p) => p.body.content), ['**Runner paused** by hand', '**Runner resumed** by hand']);
});
