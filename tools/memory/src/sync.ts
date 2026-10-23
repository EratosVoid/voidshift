import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { memoryDir } from './vault.ts';

// Keeps the vault the same on every machine with plain git and any remote:
// commit what changed here, rebase onto the remote, push. Nothing here talks
// to GitHub or any host directly.

export interface SyncResult {
  // Why nothing was done, when nothing was.
  skipped?: string;
  committed: boolean;
  pulled: number;
  pushed: boolean;
  // Notes both sides changed: the remote's version is kept and this
  // machine's is saved beside it under these paths.
  conflicts: string[];
}

type Out = { ok: boolean; stdout: string; stderr: string };

function git(vault: string, args: string[], env: Record<string, string> = {}): Out {
  const r = spawnSync('git', args, { cwd: vault, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

// File contents at an index stage, byte for byte (no trimming).
function staged(vault: string, stage: 2 | 3, file: string): string | null {
  const r = spawnSync('git', ['show', `:${stage}:${file}`], { cwd: vault, encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? r.stdout : null;
}

function must(out: Out, what: string): string {
  if (!out.ok) throw new Error(`${what}: ${out.stderr || out.stdout}`);
  return out.stdout;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:T]/g, '');
const host = () => hostname().split('.')[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'machine';

// Where this machine's side of a conflicted note is saved: next to it, so it
// shows up in the vault and in `vsf memory check` until someone merges it.
export function conflictPath(path: string, machine: string, at: Date): string {
  const dot = path.lastIndexOf('.');
  const [base, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  return `${base}.conflict-${machine}-${stamp(at)}${ext}`;
}

// Commits used for sync carry the machine's name, and an identity when git
// has none, so a fresh machine can still sync.
function identity(vault: string): Record<string, string> {
  const name = git(vault, ['config', 'user.name']).stdout;
  const email = git(vault, ['config', 'user.email']).stdout;
  return name && email ? {} : { GIT_AUTHOR_NAME: `vsf on ${host()}`, GIT_AUTHOR_EMAIL: `vsf@${host()}`, GIT_COMMITTER_NAME: `vsf on ${host()}`, GIT_COMMITTER_EMAIL: `vsf@${host()}` };
}

function commitAll(vault: string, message: string): boolean {
  must(git(vault, ['add', '-A']), 'git add');
  if (git(vault, ['diff', '--cached', '--quiet']).ok) return false;
  must(git(vault, ['commit', '-q', '-m', message], identity(vault)), 'git commit');
  return true;
}

// Finishes a rebase that stopped on conflicts: for every conflicted note the
// remote's version stays and this machine's is written beside it.
function resolveRebase(vault: string, now: Date, conflicts: string[]): void {
  for (let guard = 0; guard < 100; guard++) {
    const files = git(vault, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    if (!files.length) {
      const cont = git(vault, ['-c', 'core.editor=true', 'rebase', '--continue'], identity(vault));
      const rebasing = existsSync(join(vault, '.git', 'rebase-merge')) || existsSync(join(vault, '.git', 'rebase-apply'));
      if (cont.ok && !rebasing) return;
      if (cont.ok) continue;
      // An empty commit after resolving: skip it and carry on.
      if (/nothing to commit|empty/i.test(cont.stdout + cont.stderr)) {
        git(vault, ['rebase', '--skip']);
        continue;
      }
      throw new Error(`git rebase --continue: ${cont.stderr || cont.stdout}`);
    }
    for (const file of files) {
      // During a rebase, stage 2 is the remote side and stage 3 is ours.
      const mine = staged(vault, 3, file);
      if (mine !== null) {
        const side = conflictPath(file, host(), now);
        mkdirSync(dirname(join(vault, side)), { recursive: true });
        writeFileSync(join(vault, side), mine);
        git(vault, ['add', side]);
        conflicts.push(side);
      }
      const theirs = staged(vault, 2, file);
      if (theirs !== null) {
        writeFileSync(join(vault, file), theirs);
        git(vault, ['add', file]);
      } else git(vault, ['rm', '-q', '-f', '--', file]);
    }
  }
  throw new Error('git rebase did not finish');
}

export function syncVault(vault: string, now = new Date()): SyncResult {
  const result: SyncResult = { committed: false, pulled: 0, pushed: false, conflicts: [] };
  if (!existsSync(join(vault, '.git'))) return { ...result, skipped: 'the vault is not a git repository' };
  if (!git(vault, ['remote', 'get-url', 'origin']).ok) return { ...result, skipped: 'the vault has no remote named origin' };
  const branch = must(git(vault, ['branch', '--show-current']), 'git branch');
  if (!branch) return { ...result, skipped: 'the vault is not on a branch' };
  result.committed = commitAll(vault, `memory: notes from ${host()}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    must(git(vault, ['fetch', '-q', 'origin']), 'git fetch');
    const remote = `origin/${branch}`;
    if (git(vault, ['rev-parse', '--verify', '-q', remote]).ok) {
      result.pulled += Number(git(vault, ['rev-list', '--count', `HEAD..${remote}`]).stdout) || 0;
      const rebase = git(vault, ['rebase', '-q', remote], identity(vault));
      if (!rebase.ok) resolveRebase(vault, now, result.conflicts);
    }
    const ahead = git(vault, ['rev-parse', '--verify', '-q', remote]).ok ? Number(git(vault, ['rev-list', '--count', `${remote}..HEAD`]).stdout) || 0 : 1;
    if (!ahead) return result;
    if (git(vault, ['push', '-q', 'origin', `HEAD:${branch}`]).ok) {
      result.pushed = true;
      return result;
    }
    // Someone pushed in between: fetch, rebase and try once more.
  }
  throw new Error('git push was rejected twice');
}

// When the last sync ran on this machine, for status and the stale check.
const statePath = (configDir: string) => join(memoryDir(configDir), 'sync.json');

export function readLastSync(configDir: string): { at: string; ok: boolean; message?: string } | null {
  try {
    return JSON.parse(readFileSync(statePath(configDir), 'utf8'));
  } catch {
    return null;
  }
}

export function writeLastSync(configDir: string, ok: boolean, message?: string): void {
  mkdirSync(memoryDir(configDir), { recursive: true });
  writeFileSync(statePath(configDir), JSON.stringify({ at: new Date().toISOString(), ok, ...(message ? { message } : {}) }) + '\n');
}

export const isStale = (configDir: string, minutes: number, now = Date.now()) => {
  const last = readLastSync(configDir);
  return !last || now - Date.parse(last.at) > minutes * 60_000;
};

// One line for logs and status.
export function describeSync(r: SyncResult): string {
  if (r.skipped) return `Not synced: ${r.skipped}.`;
  const parts = [r.committed ? 'committed local notes' : '', r.pulled ? `pulled ${r.pulled} change${r.pulled === 1 ? '' : 's'}` : '', r.pushed ? 'pushed' : ''].filter(Boolean);
  const head = parts.length ? `Synced: ${parts.join(', ')}.` : 'Already in sync.';
  return r.conflicts.length ? `${head} ${r.conflicts.length} note${r.conflicts.length === 1 ? '' : 's'} changed on both sides; this machine's copy is saved beside it: ${r.conflicts.join(', ')}` : head;
}
