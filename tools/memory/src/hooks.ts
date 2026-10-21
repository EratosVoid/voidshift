import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Home } from './vault.ts';

// Recall runs as a UserPromptSubmit hook. Claude Code keeps hooks in
// settings.json, Codex in hooks.json; both use the same shape.
export const hookFile = (home: Home) => join(home.dir, home.kind === 'claude' ? 'settings.json' : 'hooks.json');

const OURS = / memory recall$/;
const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const recallCommand = (selfCommand: string[]) => [...selfCommand, 'memory', 'recall'].map(quote).join(' ');

type Settings = { hooks?: Record<string, { matcher?: string; hooks?: { type: string; command?: string; timeout?: number }[] }[]> };

function read(path: string): Settings {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Settings) : {};
}

const commands = (s: Settings) => (s.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '');

// Another memory hook already recalls into this home, e.g. one VoidLens added.
export function otherRecall(home: Home): string | undefined {
  try {
    return commands(read(hookFile(home))).find((c) => !OURS.test(c) && /inject\.sh|memory|recall/i.test(c));
  } catch {
    return undefined;
  }
}

export function hasOurHook(home: Home): boolean {
  try {
    return commands(read(hookFile(home))).some((c) => OURS.test(c));
  } catch {
    return false;
  }
}

// Adds our hook, or replaces it when the command moved. Everything else in
// the file is kept as it was.
export function addHook(home: Home, command: string): void {
  const path = hookFile(home);
  const s = read(path);
  s.hooks ??= {};
  const groups = (s.hooks.UserPromptSubmit ?? []).filter((g) => !(g.hooks ?? []).some((h) => OURS.test(h.command ?? '')));
  groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  s.hooks.UserPromptSubmit = groups;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
}

export function removeHook(home: Home): void {
  const path = hookFile(home);
  if (!existsSync(path)) return;
  const s = read(path);
  const groups = (s.hooks?.UserPromptSubmit ?? []).filter((g) => !(g.hooks ?? []).some((h) => OURS.test(h.command ?? '')));
  if (!s.hooks) return;
  if (groups.length) s.hooks.UserPromptSubmit = groups;
  else delete s.hooks.UserPromptSubmit;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
}
