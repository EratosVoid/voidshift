import { existsSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import type { Home } from './vault.ts';

export interface VaultProblems {
  notes: number;
  // Notes INDEX.md never links to, so recall never finds them.
  unindexed: string[];
  // INDEX.md links to files that are not there.
  brokenIndex: string[];
  // [[name]] links that match no note.
  brokenLinks: { note: string; link: string }[];
}

const stripCode = (text: string) => text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

export function frontmatterName(text: string): string | undefined {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm?.[1]?.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1];
}

// Note paths INDEX.md lists, by the same rule recall's match() uses: a line
// starting with "- " whose first link ends in .md (spaces allowed). Fenced
// blocks and inline code are examples, not entries.
export function indexTargets(index: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const raw of index.split('\n')) {
    const mark = raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (mark) {
      if (!fence) fence = mark[0]!;
      else if (mark[0] === fence) fence = '';
      continue;
    }
    if (fence) continue;
    const line = raw.replace(/`[^`\n]*`/g, '');
    if (!line.startsWith('- ')) continue;
    const target = line.match(/\[([^\]]*)\]\(([^)]*\.md)\)/)?.[2];
    if (target && !target.includes('://')) out.push(posix.normalize(target.replace(/^\.\//, '')));
  }
  return out;
}

// Pure over a map of note path (relative to the vault) -> text and the text
// of INDEX.md.
export function analyzeVault(files: Map<string, string>, index: string): VaultProblems {
  const targets = new Set(indexTargets(index));
  const names = new Set<string>();
  for (const [path, text] of files) {
    const base = posix.basename(path, '.md').toLowerCase();
    names.add(base);
    names.add(path.replace(/\.md$/, '').toLowerCase());
    const fm = frontmatterName(text);
    if (fm) names.add(fm.toLowerCase());
  }
  const brokenLinks: VaultProblems['brokenLinks'] = [];
  for (const [path, text] of files) {
    for (const m of stripCode(text).matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
      const name = m[1]!.split('|')[0]!.split('#')[0]!.trim();
      if (name && !names.has(name.toLowerCase())) brokenLinks.push({ note: path, link: name });
    }
  }
  return {
    notes: files.size,
    unindexed: [...files.keys()].filter((p) => !targets.has(p)).sort(),
    brokenIndex: [...targets].filter((t) => !files.has(t)).sort(),
    brokenLinks,
  };
}

export const hasProblems = (p: VaultProblems) => !!(p.unindexed.length || p.brokenIndex.length || p.brokenLinks.length);

// Splits a shell command line the way recallCommand quotes it: bare words,
// 'single quoted' words with '\'' for a quote, "double quoted" and backslashes.
export function shellTokens(cmd: string, limit = Infinity): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: '' | "'" | '"' = '';
  for (let i = 0; i < cmd.length && out.length < limit; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started && out.length < limit) out.push(cur);
  return out;
}

// The absolute paths among a hook command's first two tokens (node, script)
// that do not exist.
export function missingHookPaths(cmd: string, exists: (p: string) => boolean = existsSync): string[] {
  return shellTokens(cmd, 2).filter((t) => isAbsolute(t) && !exists(t));
}

// Problems with a config someone wants saved. Empty means it is fine.
export function validateMemoryConfig(
  value: Record<string, unknown>,
  o: { isVault: (dir: string) => boolean; exists: (dir: string) => boolean },
): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(value)) if (k !== 'vault' && k !== 'homes') problems.push(`unknown key "${k}"`);
  const { vault, homes } = value;
  if (typeof vault !== 'string' || !vault) problems.push('vault must be a folder path');
  else if (!isAbsolute(vault)) problems.push(`vault must be an absolute path (no "~"), got ${vault}`);
  else if (!o.isVault(vault)) problems.push(`vault ${vault} has no INDEX.md`);
  if (!Array.isArray(homes)) problems.push('homes must be a list of { kind, dir }');
  else {
    homes.forEach((h: unknown, i) => {
      const home = h as Partial<Home> | null;
      if (!home || typeof home !== 'object') return void problems.push(`homes[${i}] must be { kind, dir }`);
      for (const k of Object.keys(home)) if (k !== 'kind' && k !== 'dir') problems.push(`homes[${i}] has unknown key "${k}"`);
      if (home.kind !== 'claude' && home.kind !== 'codex') problems.push(`homes[${i}].kind must be "claude" or "codex"`);
      if (typeof home.dir !== 'string' || !home.dir) problems.push(`homes[${i}].dir must be a folder path`);
      else if (!isAbsolute(home.dir)) problems.push(`homes[${i}].dir must be an absolute path (no "~"), got ${home.dir}`);
      else if (!o.exists(home.dir)) problems.push(`homes[${i}].dir ${home.dir} does not exist`);
    });
  }
  return problems;
}

const homeKey = (h: Home) => `${h.kind}\0${h.dir}`;

// Which homes a config change takes out of use and which it brings in.
export function diffHomes(before: Home[], after: Home[]): { removed: Home[]; added: Home[] } {
  const was = new Set(before.map(homeKey));
  const now = new Set(after.map(homeKey));
  return { removed: before.filter((h) => !now.has(homeKey(h))), added: after.filter((h) => !was.has(homeKey(h))) };
}
