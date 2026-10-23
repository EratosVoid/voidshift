import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir, readAgentsConfig } from './config.ts';
import { keyStore, readSecret, removeSecret, storeSecret } from './secrets.ts';
import { listRuns } from './state.ts';

// Run pings go to a Discord webhook: one global, and optionally one per
// workflow that wins over it. Both are kept as secrets.
const WEBHOOK = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const LIMIT = 2000;
const TIMEOUT_MS = 5000;

export const looksLikeWebhook = (url: string) => WEBHOOK.test(url);

// A workflow name as it can appear in a secret name.
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const secretName = (workflow?: string) => (workflow ? `discord-${slug(workflow)}` : 'discord');

// Never throws: a secrets file that cannot be read means no ping.
function readWebhook(configDir: string, workflow: string | undefined, platform: NodeJS.Platform): string | null {
  if (workflow !== undefined && !slug(workflow)) return null;
  try {
    return readSecret(configDir, secretName(workflow), platform);
  } catch {
    return null;
  }
}

// The workflow's own webhook, else the global one.
export const webhookFor = (configDir: string, workflow?: string, platform: NodeJS.Platform = process.platform): string | null =>
  (workflow ? readWebhook(configDir, workflow, platform) : null) ?? readWebhook(configDir, undefined, platform);

// Posts one message. Never throws: returns why it failed, or null. A slow
// network gives up after the timeout, even when the fetch ignores its signal.
export async function postDiscord(url: string, content: string, fetcher: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`no answer from Discord in ${timeoutMs / 1000}s`), timeoutMs);
  });
  const send = (async () => {
    try {
      const res = await fetcher(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        // No mentions are parsed, so card text can never ping anyone.
        body: JSON.stringify({ content: content.slice(0, LIMIT), username: 'VoidShift', allowed_mentions: { parse: [] } }),
      });
      return res.ok ? null : `Discord answered ${res.status}`;
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      return `could not reach Discord (${cause?.code ?? cause?.message ?? (err as Error).message})`;
    }
  })();
  try {
    return await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// How a run ended, as a ping. `passed` is a verified run with no pull request.
export type RunKind = 'ready' | 'passed' | 'parked' | 'failed';

export interface RunEvent {
  kind: RunKind;
  card: string;
  title: string;
  workflow: string;
  // The card's page; a scheduled run has none.
  url?: string;
  prUrl?: string;
  reason?: string;
}

const HEADINGS: Record<RunKind, string> = { ready: 'PR ready', passed: 'Checks passed', parked: 'Parked', failed: 'Failed' };

export function runMessage(e: RunEvent): string {
  const link = e.prUrl || e.url;
  const reason = (e.kind === 'parked' || e.kind === 'failed') && e.reason ? e.reason.slice(0, 300) : '';
  return [`**${HEADINGS[e.kind]}** ${e.card} ${e.title}, workflow ${e.workflow}`, link ?? '', reason].filter(Boolean).join('\n');
}

// Pings the run's webhook, if one is set. Logs a failure and never throws.
export async function notifyRun(configDir: string, e: RunEvent, log: (line: string) => void, fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<void> {
  const url = webhookFor(configDir, e.workflow, platform);
  if (!url) return;
  const err = await postDiscord(url, runMessage(e), fetcher);
  if (err) log(`discord: ${err}`);
}

// The runner paused or resumed, with why; a budget pause can use it too.
export async function notifyRunner(configDir: string, paused: boolean, reason: string, log: (line: string) => void, fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<void> {
  const url = webhookFor(configDir, undefined, platform);
  if (!url) return;
  const err = await postDiscord(url, `**Runner ${paused ? 'paused' : 'resumed'}** ${reason}`, fetcher);
  if (err) log(`discord: ${err}`);
}

// When the daily summary last went out, so it is sent once a day.
export interface NotifyState {
  // Local day, YYYY-MM-DD.
  summaryDay?: string;
  summaryAt?: string;
}

const notifyPath = (configDir: string) => join(agentsDir(configDir), 'notify.json');

export function readNotifyState(configDir: string): NotifyState {
  try {
    return JSON.parse(readFileSync(notifyPath(configDir), 'utf8')) as NotifyState;
  } catch {
    return {};
  }
}

export function writeNotifyState(configDir: string, state: NotifyState): void {
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(notifyPath(configDir), JSON.stringify(state, null, 2) + '\n');
}

const SUMMARY_HOUR = 9;
const DAY = 86_400_000;
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Runs ended since the last summary (or the last day), counted by outcome,
// with the pull requests and parked cards.
export function summaryMessage(configDir: string, since: Date, paused: boolean): string | null {
  const runs = listRuns(configDir)
    .map((e) => e.record)
    .filter((r) => r && r.outcome !== 'running' && r.endedAt && Date.parse(r.endedAt) > since.getTime());
  if (!runs.length) return null;
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r!.outcome, (counts.get(r!.outcome) ?? 0) + 1);
  const prs = runs.filter((r) => r!.outcome === 'verified' && r!.prUrl).slice(0, 10);
  const parked = runs.filter((r) => r!.outcome === 'parked').slice(0, 10);
  const lines = [`**Daily summary** ${[...counts].map(([o, n]) => `${n} ${o}`).join(', ')}`];
  if (paused) lines.push('Runner paused');
  if (prs.length) lines.push('PRs:', ...prs.map((r) => `${r!.card} ${r!.prUrl}`));
  if (parked.length) lines.push('Parked:', ...parked.map((r) => `${r!.card} ${r!.title}${r!.reason ? `: ${r!.reason.slice(0, 120)}` : ''}`));
  return lines.join('\n');
}

// Sends the summary once a day, on the first call at or after 09:00 local.
// The day is recorded before posting, so overlapping calls send it once.
export async function sendSummary(configDir: string, paused: boolean, log: (line: string) => void, now = new Date(), fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    if (now.getHours() < SUMMARY_HOUR) return;
    const state = readNotifyState(configDir);
    const today = localDay(now);
    if (state.summaryDay === today) return;
    const url = webhookFor(configDir, undefined, platform);
    if (!url) return;
    const since = state.summaryAt ? new Date(state.summaryAt) : new Date(now.getTime() - DAY);
    writeNotifyState(configDir, { summaryDay: today, summaryAt: now.toISOString() });
    const message = summaryMessage(configDir, since, paused);
    if (!message) return;
    const err = await postDiscord(url, message, fetcher);
    if (err) log(`discord: ${err}`);
  } catch (err) {
    log(`discord: ${(err as Error).message}`);
  }
}

// Why an override cannot be kept for this workflow, or null.
function overrideProblem(configDir: string, workflow: string): string | null {
  const s = slug(workflow);
  if (!s) return `Workflow ${workflow} has no letters or digits, so it cannot have its own webhook.`;
  const other = Object.keys(readAgentsConfig(configDir).workflows).find((n) => n !== workflow && slug(n) === s);
  return other ? `Workflows ${workflow} and ${other} would share a webhook. Rename one first.` : null;
}

// Tests the webhook with one message and stores it only when that worked.
export async function addWebhook(configDir: string, url: string, workflow: string | undefined, log: (line: string) => void, fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!looksLikeWebhook(url)) {
    log('That is not a Discord webhook URL. It looks like https://discord.com/api/webhooks/123/abc.');
    return false;
  }
  const problem = workflow ? overrideProblem(configDir, workflow) : null;
  if (problem) {
    log(problem);
    return false;
  }
  const err = await postDiscord(url, `VoidShift is connected. Run pings${workflow ? ` for workflow ${workflow}` : ''} come here.`, fetcher);
  if (err) {
    log(`Discord did not take the test message: ${err}. Nothing was stored.`);
    return false;
  }
  if (!storeSecret(configDir, secretName(workflow), url, platform)) {
    log(`Discord took the test message but the webhook could not be stored in ${keyStore(platform)}.`);
    return false;
  }
  log(`Webhook${workflow ? ` for workflow ${workflow}` : ''} stored in ${keyStore(platform)}. A test message was sent.`);
  return true;
}

// Sends a test message to the webhook a workflow's runs would use.
export async function testWebhook(configDir: string, workflow: string | undefined, log: (line: string) => void, fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const url = webhookFor(configDir, workflow, platform);
  if (!url) {
    log('No webhook set. Run vsf agents discord to add one.');
    return false;
  }
  const err = await postDiscord(url, `Test message from VoidShift${workflow ? ` for workflow ${workflow}` : ''}.`, fetcher);
  log(err ? `discord: ${err}` : 'Test message sent.');
  return !err;
}

export function removeWebhook(configDir: string, workflow: string | undefined, log: (line: string) => void, platform: NodeJS.Platform = process.platform): boolean {
  if (!readWebhook(configDir, workflow, platform)) {
    log('No webhook set.');
    return true;
  }
  if (!removeSecret(configDir, secretName(workflow), platform)) {
    log(`Could not remove the webhook from ${keyStore(platform)}.`);
    return false;
  }
  log(`Webhook${workflow ? ` for workflow ${workflow}` : ''} removed.`);
  return true;
}

// Carries a workflow's webhook across a rename. Returns why the rename must
// not go ahead, or null; nothing is changed when it refuses.
export function moveWebhook(configDir: string, from: string, to: string, platform: NodeJS.Platform = process.platform): string | null {
  if (slug(from) === slug(to)) return null;
  const mine = readWebhook(configDir, from, platform);
  const theirs = slug(to) ? readWebhook(configDir, to, platform) : null;
  if (!mine && !theirs) return null;
  if (!slug(to)) return `${to} has no letters or digits, so workflow ${from} would lose its webhook. Pick another name.`;
  const other = Object.keys(readAgentsConfig(configDir).workflows).find((n) => n !== from && slug(n) === slug(to));
  if (other) return `Workflow ${other} would share a webhook with ${to}. Pick another name.`;
  // A webhook left behind by a deleted workflow is not inherited.
  if (theirs) removeSecret(configDir, secretName(to), platform);
  if (mine) {
    if (!storeSecret(configDir, secretName(to), mine, platform)) return `Could not move the webhook of workflow ${from}.`;
    removeSecret(configDir, secretName(from), platform);
  }
  return null;
}

// Drops a deleted workflow's webhook. Never throws.
export function dropWebhook(configDir: string, workflow: string, platform: NodeJS.Platform = process.platform): void {
  try {
    if (readWebhook(configDir, workflow, platform)) removeSecret(configDir, secretName(workflow), platform);
  } catch {
    // nothing more to do
  }
}
