// Everything the dashboard does, it does by running a real vsf command as a
// child process (the same selfCommand the CLI hands to launchd). The dashboard
// can therefore never do something a command cannot. Reads may happen
// in-process (see data.ts); writes and anything that can block or exit the
// process (agents run, tick, cancel, stop, restart, start) come through here.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ActionResult {
  code: number;
  output: string;
}

// How to start this CLI again: node plus the real path of the entry file.
export function selfCommand(): string[] {
  return [process.execPath, realpathSync(process.argv[1] ?? '')];
}

// "vsf agents cancel ENG-12", for the footer and for confirm dialogs.
export function commandLine(args: string[]): string {
  const quote = (a: string) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ['vsf', ...args.map(quote)].join(' ');
}

// Runs `vsf <args>` with stdin ignored and stdout and stderr captured.
export function runAction(args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ActionResult> {
  return new Promise((resolve) => {
    const [cmd, ...pre] = selfCommand();
    let output = '';
    let child;
    try {
      child = spawn(cmd!, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env } });
    } catch (err) {
      resolve({ code: 1, output: (err as Error).message });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          output += '\nTimed out.';
          child.kill('SIGTERM');
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, output: output + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim() });
    });
  });
}

// Starts a long run that outlives the keypress: output is appended to
// logFile and the dashboard goes on, following the run from run.json.
export function spawnDetached(args: string[], logFile: string): { pid: number | undefined } {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    writeSync(fd, `\n--- ${new Date().toISOString()} ${commandLine(args)}\n`);
    const [cmd, ...pre] = selfCommand();
    const child = spawn(cmd!, [...pre, ...args], { detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {});
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

// Runs a command that needs the real terminal (prompts, an editor, a long
// foreground run) with stdio inherited. Call it only while Ink has released
// the terminal (useApp().suspendTerminal).
export function runInTerminal(args: string[]): number {
  const [cmd, ...pre] = selfCommand();
  return spawnSync(cmd!, [...pre, ...args], { stdio: 'inherit' }).status ?? 1;
}

// Commands that prompt, open an editor or run in the foreground. The
// dashboard hands them the terminal instead of capturing their output.
export function needsTerminal(args: string[]): boolean {
  const [a, b, c] = args;
  if (a === 'setup' || a === 'add' || a === 'remove') return true;
  if (a === 'config' && b === 'edit') return true;
  if (a === 'agents') {
    if (b === 'run' || b === 'key') return true;
    if (b === 'logs' && args.some((x) => x === '-f' || x === '--follow')) return true;
    if ((b === 'workflow' || b === 'project') && (c === 'add' || c === 'edit') && !args.includes('--yes')) return true;
    if ((b === 'workflow' || b === 'project') && c === 'rm' && !args.includes('--yes') && !args.includes('-y')) return true;
  }
  if (a === 'awake' && b === 'logs' && args.some((x) => x === '-f' || x === '--follow')) return true;
  return false;
}

// First and last non-empty lines, for toasts.
export const firstLine = (text: string): string => text.split('\n').find((l) => l.trim())?.trim() ?? '';
export const lastLine = (text: string): string => [...text.split('\n')].reverse().find((l) => l.trim())?.trim() ?? '';
