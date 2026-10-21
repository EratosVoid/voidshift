import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolEntry } from './registry.ts';
import type { Tool } from './tool.ts';

// Inside the monorepo, tools load straight from source. Installed copies
// live under <configDir>/tools, one npm prefix shared by every tool.
function sourcePath(entry: ToolEntry): string {
  return fileURLToPath(new URL(`../../../tools/${entry.name}/src/index.ts`, import.meta.url));
}

function installedPath(entry: ToolEntry, configDir: string): string {
  return join(configDir, 'tools', 'node_modules', entry.pkg, 'dist', 'index.js');
}

export function locate(entry: ToolEntry, configDir: string): string | null {
  for (const p of [sourcePath(entry), installedPath(entry, configDir)]) if (existsSync(p)) return p;
  return null;
}

export function fetchTool(entry: ToolEntry, configDir: string): boolean {
  if (locate(entry, configDir)) return true;
  const r = spawnSync('npm', ['install', '--prefix', join(configDir, 'tools'), entry.pkg], { stdio: 'inherit' });
  return r.status === 0 && locate(entry, configDir) !== null;
}

// Tools added elsewhere (or before an update) may not be downloaded on this
// install yet, so fetch on first use rather than failing.
export async function loadTool(entry: ToolEntry, configDir: string): Promise<Tool> {
  const path = locate(entry, configDir) ?? (fetchTool(entry, configDir) ? locate(entry, configDir) : null);
  if (!path) throw new Error(`could not download ${entry.pkg}. Check your connection and run voidshift again.`);
  const mod = (await import(pathToFileURL(path).href)) as { default: Tool };
  return mod.default;
}
