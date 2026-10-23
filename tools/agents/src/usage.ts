import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readWindow, writeWindow, type Window } from './state.ts';

// The Claude subscription's 5 hour window. The runner reads it every few
// minutes with Claude Code's own login, read only: the token is never
// refreshed here, so an expired one just means no reading until Claude runs.
export const WINDOW_MS = 5 * 60_000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export interface TokenSource {
  platform?: NodeJS.Platform;
  // Claude Code's config folder; CLAUDE_CONFIG_DIR or ~/.claude when unset.
  claudeDir?: string;
  now?: number;
}

// Claude Code's access token: the macOS Keychain first, then its credentials file.
export function readClaudeToken(o: TokenSource = {}): { token: string } | { error: string } {
  let text = '';
  if ((o.platform ?? process.platform) === 'darwin') {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) text = r.stdout.trim();
  }
  if (!text) {
    try {
      text = readFileSync(join(o.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')), '.credentials.json'), 'utf8');
    } catch {
      return { error: 'no Claude login found' };
    }
  }
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch {
    return { error: 'the Claude credentials could not be read' };
  }
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return { error: 'no Claude login found' };
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= (o.now ?? Date.now())) return { error: 'the Claude login has expired; it renews when Claude next runs' };
  return { token: oauth.accessToken };
}

// Percent used, whether the answer is on a 0 to 1 or a 0 to 100 scale.
export const toPercent = (v: number) => (v > 0 && v < 1 ? v * 100 : v);

export async function fetchWindow(token: string, fetcher: typeof fetch = fetch): Promise<Pick<Window, 'utilization' | 'resetsAt'>> {
  const res = await fetcher(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the usage endpoint answered ${res.status}`);
  const five = ((await res.json()) as { five_hour?: { utilization?: unknown; resets_at?: unknown } } | null)?.five_hour;
  const u = typeof five?.utilization === 'number' ? five.utilization : NaN;
  if (!Number.isFinite(u)) throw new Error('the answer had no 5 hour window');
  const resets = typeof five?.resets_at === 'string' ? new Date(five.resets_at) : null;
  return { utilization: toPercent(u), ...(resets && !isNaN(resets.getTime()) ? { resetsAt: resets.toISOString() } : {}) };
}

// A reading is stale after 5 minutes, or once its window has reset.
export function windowStale(w: Window | null, now = new Date()): boolean {
  if (!w) return true;
  if (now.getTime() - Date.parse(w.checkedAt) >= WINDOW_MS) return true;
  return !!w.resetsAt && Date.parse(w.resetsAt) <= now.getTime();
}

// Reads the window and saves it to window.json. Never throws: a failure is
// saved as the error, keeping the old reading while its window is still on.
export async function refreshWindow(configDir: string, fetcher: typeof fetch = fetch, token: () => ReturnType<typeof readClaudeToken> = readClaudeToken, now = new Date()): Promise<Window> {
  const old = readWindow(configDir);
  const keep = old?.utilization !== undefined && old.resetsAt && Date.parse(old.resetsAt) > now.getTime() ? { utilization: old.utilization, resetsAt: old.resetsAt } : {};
  const checkedAt = now.toISOString();
  let w: Window;
  try {
    const t = token();
    w = 'error' in t ? { checkedAt, ...keep, error: t.error } : { checkedAt, ...(await fetchWindow(t.token, fetcher)) };
  } catch (err) {
    w = { checkedAt, ...keep, error: (err as Error).message };
  }
  writeWindow(configDir, w);
  return w;
}

// When new runs may start again, or null when they may start now. Holds once
// the window is at `pauseAt` percent, until it resets; 0 never holds.
export function windowHold(w: Window | null, pauseAt: number, now = new Date()): string | null {
  if (!w || pauseAt <= 0 || w.utilization === undefined || !w.resetsAt) return null;
  return w.utilization >= pauseAt && Date.parse(w.resetsAt) > now.getTime() ? w.resetsAt : null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// What status prints for the window, or empty with nothing read yet.
export function windowLine(w: Window | null, pauseAt: number, now = new Date()): string {
  if (!w) return '';
  if (w.utilization === undefined) return w.error ? `Window: could not read the 5 hour window (${w.error}).` : '';
  const pct = Math.round(w.utilization);
  const until = windowHold(w, pauseAt, now);
  if (until) return `Window: held at ${pct}% until ${clock(until)}, running cards finish.`;
  const resets = w.resetsAt && Date.parse(w.resetsAt) > now.getTime() ? `, resets ${clock(w.resetsAt)}` : '';
  return `Window: 5 hour at ${pct}%${resets}.`;
}
