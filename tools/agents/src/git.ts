import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { track } from './engine.ts';

export interface Out {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function sh(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Out {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  return { ok: r.status === 0, code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function must(out: Out, what: string): string {
  if (!out.ok) throw new Error(`${what} failed: ${out.stderr || out.stdout}`);
  return out.stdout;
}

export function defaultBranch(repo: string): string {
  const ref = sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
  if (ref.ok) return ref.stdout.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (sh('git', ['rev-parse', '--verify', `origin/${b}`], repo).ok) return b;
  throw new Error(`cannot tell the default branch of ${repo}`);
}

// A worktree per card on the card's branch, so the developer's checkout is
// never touched.
export function ensureWorktree(repo: string, path: string, branch: string, base: string): void {
  must(sh('git', ['fetch', 'origin'], repo), 'git fetch');
  if (existsSync(path)) {
    sh('git', ['pull', '--ff-only', 'origin', branch], path);
    return;
  }
  const remote = sh('git', ['rev-parse', '--verify', `origin/${branch}`], repo).ok;
  const local = sh('git', ['rev-parse', '--verify', branch], repo).ok;
  const args = remote
    ? ['worktree', 'add', '-B', branch, path, `origin/${branch}`]
    : local
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, `origin/${base}`];
  must(sh('git', args, repo), 'git worktree add');
}

export function commitsAhead(worktree: string, base: string): number {
  const out = sh('git', ['rev-list', '--count', `origin/${base}..HEAD`], worktree);
  return out.ok ? Number(out.stdout) : 0;
}

export function headSha(worktree: string): string {
  return sh('git', ['rev-parse', 'HEAD'], worktree).stdout;
}

export function push(worktree: string, branch: string): void {
  must(sh('git', ['push', '-u', 'origin', branch], worktree), 'git push');
}

// The branch's open pull request. A closed one is reopened, since a closed PR
// never runs CI on new commits; a merged one gets a fresh PR.
export function ensureDraftPr(worktree: string, branch: string, base: string, title: string, body: string): string {
  const view = sh('gh', ['pr', 'view', branch, '--json', 'url,state', '-q', '.state + " " + .url'], worktree);
  const [state, url] = view.ok ? view.stdout.split(' ') : [];
  if (state === 'OPEN' && url) return url;
  if (state === 'CLOSED' && url && sh('gh', ['pr', 'reopen', branch], worktree).ok) return url;
  return must(
    sh('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', title, '--body', body], worktree),
    'gh pr create',
  );
}

export function markReady(worktree: string, branch: string): boolean {
  return sh('gh', ['pr', 'ready', branch], worktree).ok;
}

export interface CheckSummary {
  failed: { name: string; link: string }[];
  pending: string[];
  passed: number;
}

// Parses plain `gh pr checks` output: name, state, duration, link per line,
// tab separated. Works on old gh versions that lack --json.
export function summarizeChecks(text: string): CheckSummary {
  const out: CheckSummary = { failed: [], pending: [], passed: 0 };
  for (const line of text.split('\n')) {
    const [name, state, , link] = line.split('\t');
    if (!name || !state) continue;
    if (state === 'pass' || state === 'skipping') out.passed++;
    else if (state === 'pending') out.pending.push(name.trim());
    else out.failed.push({ name: name.trim(), link: (link ?? '').trim() });
  }
  return out;
}

// One short line per failed check, for the card and for Dev.
export function ciReport(s: CheckSummary): string {
  const lines = s.failed.map((f) => `- ${f.name}${f.link ? `: ${f.link}` : ''}`);
  const pending = s.pending.length ? `\nStill running: ${s.pending.join(', ')}.` : '';
  return `CI failed:\n${lines.join('\n')}${pending}`;
}

// Waits for CI on the PR, then reads the final state once. Repos without CI
// pass through as SKIP.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// True once GitHub shows `sha` as the head of the branch's pull request, so the
// checks read next belong to that commit and not to an older push.
export async function waitForPrHead(worktree: string, branch: string, sha: string, timeoutMs = 3 * 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const head = sh('gh', ['pr', 'view', branch, '--json', 'headRefOid', '-q', '.headRefOid'], worktree);
    if (head.ok && head.stdout === sha) return true;
    if (Date.now() > until) return false;
    await sleep(10_000);
  }
}

// CI for the pull request's current head. Checks take a moment to register
// after a push, so "no checks" only counts once they have had time to show up.
export async function waitForChecks(worktree: string, branch: string, timeoutMs = 30 * 60_000, settleMs = 2 * 60_000): Promise<{ verdict: 'SHIP' | 'FIX' | 'SKIP' | 'PENDING'; report: string }> {
  const settled = Date.now() + settleMs;
  const noChecks = () => {
    const out = sh('gh', ['pr', 'checks', branch], worktree);
    return /no checks reported/i.test(`${out.stdout}\n${out.stderr}`);
  };
  while (Date.now() < settled && noChecks()) await sleep(15_000);
  return new Promise((resolve) => {
    const child = spawn('gh', ['pr', 'checks', branch, '--watch', '--interval', '30'], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });
    track(child);
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      if (/no checks reported/i.test(text)) return resolve({ verdict: 'SKIP', report: 'No CI checks on this repo.' });
      const summary = summarizeChecks(sh('gh', ['pr', 'checks', branch], worktree).stdout);
      if (!summary.failed.length && !summary.pending.length) return resolve({ verdict: 'SHIP', report: `CI passed (${summary.passed} checks).` });
      if (!summary.failed.length) return resolve({ verdict: 'PENDING', report: `CI did not finish in time. Still running: ${summary.pending.join(', ')}.` });
      resolve({ verdict: 'FIX', report: ciReport(summary) });
    });
  });
}

// QA runs with write access so it can start the app; nothing it changes stays.
export function resetWorktree(worktree: string): void {
  sh('git', ['reset', '--hard', 'HEAD'], worktree);
  sh('git', ['clean', '-fd'], worktree);
}
