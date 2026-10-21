import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOTS = ['me', 'code', 'Code', 'projects', 'Projects', 'dev', 'Developer', 'src', 'work', 'repos', 'git', 'GitHub', 'Documents/GitHub'];
const SKIP = new Set(['node_modules', 'Library', 'Applications', 'dist', 'build', 'vendor', 'target']);

// Git repos under the usual code folders, a few levels deep. A folder with a
// .git directory is a repo and is not searched further; worktrees (a .git
// file) are left out so each repo shows once.
export function findRepos(extraRoots: string[] = [], maxDepth = 4, limit = 400): string[] {
  const found = new Set<string>();
  const roots = [...extraRoots, ...ROOTS.map((r) => join(homedir(), r))].filter((r) => existsSync(r));
  const walk = (dir: string, depth: number) => {
    if (found.size >= limit) return;
    const git = join(dir, '.git');
    if (existsSync(git) && statSync(git).isDirectory()) {
      found.add(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        // unreadable, skip
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return [...found].sort((a, b) => a.localeCompare(b));
}
