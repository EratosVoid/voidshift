import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

export function push(worktree: string, branch: string): void {
  must(sh('git', ['push', '-u', 'origin', branch], worktree), 'git push');
}

export function ensureDraftPr(worktree: string, branch: string, base: string, title: string, body: string): string {
  const view = sh('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], worktree);
  if (view.ok && view.stdout) return view.stdout;
  return must(
    sh('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', title, '--body', body], worktree),
    'gh pr create',
  );
}

export function markReady(worktree: string, branch: string): boolean {
  return sh('gh', ['pr', 'ready', branch], worktree).ok;
}

// Waits for CI on the PR. Repos without CI pass through as SKIP.
export function waitForChecks(worktree: string, branch: string, timeoutMs = 30 * 60_000): Promise<{ verdict: 'SHIP' | 'FIX' | 'SKIP'; report: string }> {
  return new Promise((resolve) => {
    const child = spawn('gh', ['pr', 'checks', branch, '--watch', '--interval', '30'], { cwd: worktree });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const report = text.trim().split('\n').slice(-40).join('\n');
      if (/no checks reported/i.test(text)) resolve({ verdict: 'SKIP', report: 'No CI checks on this repo.' });
      else if (code === 0) resolve({ verdict: 'SHIP', report });
      else resolve({ verdict: 'FIX', report: `CI did not pass:\n\n${report}` });
    });
  });
}

// QA runs with write access so it can start the app; nothing it changes stays.
export function resetWorktree(worktree: string): void {
  sh('git', ['reset', '--hard', 'HEAD'], worktree);
  sh('git', ['clean', '-fd'], worktree);
}
