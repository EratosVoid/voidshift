import { spawn } from 'node:child_process';
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
}

// Tools a write step may use under `claude -p`. Anything else is denied,
// since nobody is there to approve it.
const CLAUDE_WRITE = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const CLAUDE_READ = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(rg:*)'];

export function engineArgs(o: RunOptions, outFile: string): { cmd: string; args: string[] } {
  if (o.engine === 'claude') {
    const vaultTools = o.vault ? [`Edit(/${o.vault}/**)`, `Write(/${o.vault}/**)`] : [];
    const args = ['-p', '--output-format', 'text', '--allowedTools', [...(o.write ? CLAUDE_WRITE : CLAUDE_READ), ...vaultTools].join(',')];
    if (o.vault) args.push('--add-dir', o.vault);
    if (o.write) args.push('--permission-mode', 'acceptEdits');
    if (o.model) args.push('--model', o.model);
    return { cmd: 'claude', args };
  }
  const args = ['exec', '-C', o.cwd, '-s', o.write ? 'workspace-write' : 'read-only', '-o', outFile];
  // A read-only sandbox cannot write anywhere, so only write steps get the vault.
  if (o.vault && o.write) args.push('--add-dir', o.vault);
  if (o.model) args.push('-m', o.model);
  args.push('-');
  return { cmd: 'codex', args };
}

// Runs one agent step with the prompt on stdin. Resolves with the agent's
// final text; everything it prints also goes to the log file.
export function runAgent(o: RunOptions): Promise<{ ok: boolean; output: string }> {
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
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      log.write(d);
    });
    child.stderr.on('data', (d) => log.write(d));
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs ?? 45 * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      log.end(`\n${err.message}\n`);
      resolve({ ok: false, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
      resolve({ ok: code === 0, output });
    });
    child.stdin.end(o.prompt);
  });
}
