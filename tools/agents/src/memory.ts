import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The memory tool's vault, when it is set up. Agents read it through
// `voidshift memory recall` and write notes into it directly.
export function vaultPath(configDir: string): string | undefined {
  const path = join(configDir, 'memory', 'config.json');
  if (!existsSync(path)) return undefined;
  try {
    const vault = (JSON.parse(readFileSync(path, 'utf8')) as { vault?: string }).vault;
    return vault && existsSync(join(vault, 'INDEX.md')) ? vault : undefined;
  } catch {
    return undefined;
  }
}

// Notes matching the text, recalled the same way as before each of your
// prompts. Empty when memory is not set up or nothing matches.
export function recall(selfCommand: string[], configDir: string, text: string): string {
  if (!vaultPath(configDir) || !selfCommand.length) return '';
  const [cmd, ...args] = selfCommand;
  const r = spawnSync(cmd!, [...args, 'memory', 'recall'], {
    input: JSON.stringify({ prompt: text, session_id: `agents-${Date.now()}` }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout.trim()) return '';
  try {
    return (JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
  } catch {
    return '';
  }
}

// Brings the vault up to date through its git remote, or shares the notes
// agents wrote. Never fails a run: returns a line worth logging, or ''.
export function syncMemory(selfCommand: string[], configDir: string): string {
  if (!vaultPath(configDir) || !selfCommand.length) return '';
  const [cmd, ...args] = selfCommand;
  const r = spawnSync(cmd!, [...args, 'memory', 'sync', '--quiet'], { encoding: 'utf8', timeout: 90_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) return `memory sync did not run (${r.error.message})`;
  return r.status === 0 ? out : out || 'memory sync failed';
}
