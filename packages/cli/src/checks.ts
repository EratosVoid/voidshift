import { spawnSync } from 'node:child_process';
import type { Check } from './tool.ts';

export interface RunResult {
  ok: boolean;
  stdout: string;
}

export type Run = (cmd: string, args: string[]) => RunResult;

export const run: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
};

export function atLeast(version: string, min: string): boolean {
  const a = version.replace(/^v/, '').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}

export function baseChecks(platform: string, nodeVersion: string, exec: Run): Check[] {
  const checks: Check[] = [];

  const linux = platform === 'linux';
  checks.push(
    platform === 'darwin' || linux
      ? { name: 'platform', status: 'ok', detail: linux ? 'Linux, supported' : 'macOS, supported' }
      : { name: 'platform', status: 'fail', detail: `${platform} is not supported yet`, fix: 'Run on macOS or Linux' },
  );

  checks.push(
    atLeast(nodeVersion, '22.18')
      ? { name: 'Node', status: 'ok', detail: nodeVersion }
      : { name: 'Node', status: 'fail', detail: `${nodeVersion} is too old`, fix: 'Install Node 22.18 or newer' },
  );

  const git = exec('git', ['--version']);
  checks.push(
    git.ok
      ? { name: 'git', status: 'ok', detail: git.stdout }
      : { name: 'git', status: 'fail', detail: 'not found', fix: linux ? 'Install git with your package manager' : 'xcode-select --install' },
  );

  const gh = exec('gh', ['auth', 'token']);
  const ghInstalled = gh.ok || exec('gh', ['--version']).ok;
  checks.push(
    gh.ok
      ? { name: 'GitHub CLI', status: 'ok', detail: 'logged in' }
      : ghInstalled
        ? { name: 'GitHub CLI', status: 'warn', detail: 'not logged in', fix: 'gh auth login' }
        : { name: 'GitHub CLI', status: 'warn', detail: 'not found', fix: linux ? 'https://cli.github.com' : 'brew install gh' },
  );

  const claude = exec('claude', ['--version']);
  const codex = exec('codex', ['--version']);
  // One agent CLI is enough: the other is only checked when neither exists.
  if (claude.ok || !codex.ok) {
    checks.push(
      claude.ok
        ? { name: 'Claude Code', status: 'ok', detail: firstLine(claude.stdout) }
        : { name: 'Claude Code', status: 'warn', detail: 'not found', fix: 'https://docs.claude.com/en/docs/claude-code' },
    );
  }
  if (codex.ok || !claude.ok) {
    checks.push(
      codex.ok
        ? { name: 'Codex CLI', status: 'ok', detail: firstLine(codex.stdout) }
        : { name: 'Codex CLI', status: 'warn', detail: 'not found', fix: 'npm i -g @openai/codex' },
    );
  }
  if (!claude.ok && !codex.ok) {
    checks.push({ name: 'Agent', status: 'fail', detail: 'neither Claude Code nor Codex is installed', fix: 'Install at least one' });
  }

  return checks;
}
