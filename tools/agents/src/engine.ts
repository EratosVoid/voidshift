import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Engine = 'claude' | 'codex';

export interface RunOptions {
  engine: Engine;
  model?: string;
  cwd: string;
  prompt: string;
  write: boolean;
  logFile: string;
  timeoutMs?: number;
  // Memory vault the agent may write notes into.
  vault?: string;
  // Claude settings from your profile, passed with --settings.
  settingsFile?: string;
  // Where the runner runs. On Linux permissions are skipped and the runner's
  // own user account is the boundary.
  platform?: NodeJS.Platform;
}

// Tools a write step may use under `claude -p`. Anything else is denied,
// since nobody is there to approve it.
const CLAUDE_WRITE = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const CLAUDE_READ = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(rg:*)'];

export function engineArgs(o: RunOptions, outFile: string): { cmd: string; args: string[] } {
  // Nobody is there to approve a prompt, and an allowlist that misses a tool
  // breaks the run, so on Linux every step runs with permissions skipped.
  const skip = (o.platform ?? process.platform) === 'linux';
  if (o.engine === 'claude' && skip) {
    const args = ['-p', '--output-format', 'text', '--dangerously-skip-permissions'];
    if (o.vault) args.push('--add-dir', o.vault);
    if (o.model) args.push('--model', o.model);
    if (o.settingsFile) args.push('--settings', o.settingsFile);
    return { cmd: 'claude', args };
  }
  if (o.engine === 'claude') {
    // Edit rules cover every file-writing tool; a Write(path) rule is ignored.
    const vaultTools = o.vault ? [`Edit(/${o.vault}/**)`] : [];
    const args = ['-p', '--output-format', 'text', '--allowedTools', [...(o.write ? CLAUDE_WRITE : CLAUDE_READ), ...vaultTools].join(',')];
    if (o.vault) args.push('--add-dir', o.vault);
    if (o.write) args.push('--permission-mode', 'acceptEdits');
    if (o.model) args.push('--model', o.model);
    if (o.settingsFile) args.push('--settings', o.settingsFile);
    return { cmd: 'claude', args };
  }
  if (skip) {
    const args = ['exec', '-C', o.cwd, '--dangerously-bypass-approvals-and-sandbox', '-o', outFile];
    if (o.model) args.push('-m', o.model);
    args.push('-');
    return { cmd: 'codex', args };
  }
  const args = ['exec', '-C', o.cwd, '-s', o.write ? 'workspace-write' : 'read-only', '-o', outFile];
  // A read-only sandbox cannot write anywhere, so only write steps get the vault.
  if (o.vault && o.write) args.push('--add-dir', o.vault);
  if (o.model) args.push('-m', o.model);
  args.push('-');
  return { cmd: 'codex', args };
}

// Agent processes running now, so a cancel can stop them.
const children = new Set<ChildProcess>();

// Registers a child process so stopAgents() can stop it.
export function track(child: ChildProcess): void {
  children.add(child);
  child.on('close', () => children.delete(child));
}

// Asks every running agent to stop and waits up to 2 seconds for them to go,
// then kills the rest. The caller exits right after, so nothing may linger.
export async function stopAgents(): Promise<void> {
  for (const c of children) c.kill('SIGTERM');
  const deadline = Date.now() + 2000;
  while (children.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
}

// Why a failed agent process failed: the last lines it wrote to stderr.
export function errorTail(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  let out = '';
  for (const line of lines.reverse()) {
    const next = out ? `${line} ${out}` : line;
    if (next.length > 300) break;
    out = next;
  }
  return out || lines[0]?.slice(-300) || '';
}

// Runs one agent step with the prompt on stdin. Resolves with the agent's
// final text; everything it prints also goes to the log file. A process that
// fails also says why in `error`.
export function runAgent(o: RunOptions): Promise<{ ok: boolean; output: string; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'voidshift-run-'));
  const outFile = join(dir, 'last.txt');
  const { cmd, args } = engineArgs(o, outFile);
  const log = createWriteStream(o.logFile, { flags: 'a' });
  log.write(`$ ${cmd} ${args.join(' ')}\n\n`);

  return new Promise((resolve) => {
    // The runner recalls memory for the card itself; the recall hook would
    // match on the whole prompt, skill text included.
    const env = { ...process.env, VOIDSHIFT_RECALL: 'off' };
    const child = spawn(cmd, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    track(child);
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      log.write(d);
    });
    // Only the tail is kept; the log has all of it.
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).split('\n').slice(-20).join('\n');
      log.write(d);
    });
    const timeoutMs = o.timeoutMs ?? 45 * 60_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      children.delete(child);
      log.end(`\n${err.message}\n`);
      resolve({ ok: false, output: err.message, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      children.delete(child);
      log.end(`\nexit ${code}\n`);
      let output = stdout;
      if (o.engine === 'codex') {
        try {
          output = readFileSync(outFile, 'utf8');
        } catch {
          // fall back to stdout
        }
      }
      rmSync(dir, { recursive: true, force: true });
      if (code === 0) return resolve({ ok: true, output });
      const minutes = Math.round(timeoutMs / 60_000);
      const error = timedOut ? `timed out after ${minutes} minute${minutes === 1 ? '' : 's'}` : errorTail(stderr) || `exit ${code}`;
      resolve({ ok: false, output, error });
    });
    child.stdin.end(o.prompt);
  });
}
