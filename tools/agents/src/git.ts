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

// What the runner does to an agent's new commits before they are pushed.
export interface CommitPolicy {
  // Add Signed-off-by for the git user, as a DCO asks.
  signOff?: boolean;
  // Drop co-author and "generated with" lines naming an AI tool.
  dropAiTrailers?: boolean;
}

const AI_LINE = /^(co-authored-by:.*(claude|anthropic|codex|openai|copilot|gemini|cursor)|.*generated with \[?(claude|codex)).*$/i;

// The message with AI lines removed and a sign-off added, as the policy asks.
export function applyPolicy(message: string, policy: CommitPolicy, signer: string | null, cwd: string): string {
  let msg = message.replace(/\r\n/g, '\n');
  if (policy.dropAiTrailers) msg = msg.split('\n').filter((l) => !AI_LINE.test(l.trim())).join('\n');
  msg = msg.replace(/\s+$/, '') + '\n';
  if (policy.signOff && signer) {
    // git's own trailer rules decide the blank line and skip a duplicate.
    const r = spawnSync('git', ['interpret-trailers', '--if-exists', 'addIfDifferent', '--trailer', `Signed-off-by: ${signer}`], { cwd, input: msg, encoding: 'utf8' });
    if (r.status === 0) msg = r.stdout;
  }
  return msg;
}

// Rewrites the commits after `from` up to HEAD so their messages follow the
// policy. Trees, authors and dates stay as they were; only commits not yet
// pushed may be passed. Returns how many changed.
export function enforceCommitPolicy(worktree: string, from: string, policy: CommitPolicy): number {
  if (!policy.signOff && !policy.dropAiTrailers) return 0;
  const name = sh('git', ['config', 'user.name'], worktree).stdout;
  const email = sh('git', ['config', 'user.email'], worktree).stdout;
  const signer = name && email ? `${name} <${email}>` : null;
  const list = sh('git', ['rev-list', '--reverse', '--parents', `${from}..HEAD`], worktree);
  if (!list.ok || !list.stdout) return 0;
  const map = new Map<string, string>();
  let changed = 0;
  let head = '';
  for (const line of list.stdout.split('\n')) {
    const [sha, ...parents] = line.split(' ');
    const info = must(sh('git', ['log', '-1', '--format=%T%x00%an%x00%ae%x00%aD%x00%cn%x00%ce%x00%cD', sha!], worktree), 'git log');
    const [tree, an, ae, ad, cn, ce, cd] = info.split('\0');
    const raw = spawnSync('git', ['log', '-1', '--format=%B', sha!], { cwd: worktree, encoding: 'utf8' }).stdout ?? '';
    const message = applyPolicy(raw, policy, signer, worktree);
    const newParents = parents.map((p) => map.get(p) ?? p);
    if (message === raw.replace(/\s+$/, '') + '\n' && newParents.every((p, i) => p === parents[i])) {
      map.set(sha!, sha!);
      head = sha!;
      continue;
    }
    const r = spawnSync('git', ['commit-tree', tree!, ...newParents.flatMap((p) => ['-p', p]), '-F', '-'], {
      cwd: worktree,
      input: message,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd },
    });
    if (r.status !== 0) throw new Error(`git commit-tree failed: ${r.stderr}`);
    const next = r.stdout.trim();
    map.set(sha!, next);
    head = next;
    changed++;
  }
  // Same tree at the tip, so moving the branch leaves the files untouched.
  if (changed) must(sh('git', ['reset', '-q', '--soft', head], worktree), 'git reset');
  return changed;
}

// Removes a worktree and its branch. Errors are ignored: either may be gone already.
export function removeWorktree(repo: string, worktree: string, branch: string): void {
  sh('git', ['worktree', 'remove', '--force', worktree], repo);
  sh('git', ['branch', '-D', branch], repo);
}
