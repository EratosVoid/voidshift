import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, readConfig } from '../config.ts';
import { findTool } from '../registry.ts';
import { CLI_PKG, cliVersion, isNewer } from '../version.ts';

const QUIET = ['--silent', '--no-audit', '--no-fund'];

export function latestVersion(pkg: string): string | null {
  const r = spawnSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function installedToolVersion(pkg: string): string | null {
  const path = join(configDir(), 'tools', 'node_modules', pkg, 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : null;
}

// Running from a checkout of the repo rather than an npm install.
const fromSource = () => fileURLToPath(import.meta.url).endsWith('.ts');

export async function update(): Promise<number> {
  let failed = false;
  let changed = false;

  // One install for every outdated tool: they share a folder, so npm may move
  // the others too. Report by comparing versions before and after.
  const tools = readConfig().tools.map((name) => findTool(name)).filter((e) => !!e);
  const before = new Map(tools.map((e) => [e.name, installedToolVersion(e.pkg)]));
  const targets: string[] = [];
  for (const entry of tools) {
    const latest = latestVersion(entry.pkg);
    if (!latest) {
      console.log(`${entry.name}: could not check npm`);
      failed = true;
      continue;
    }
    const current = before.get(entry.name);
    if (!current || isNewer(latest, current)) targets.push(`${entry.pkg}@${latest}`);
  }
  if (targets.length) {
    const r = spawnSync('npm', ['install', ...QUIET, '--prefix', join(configDir(), 'tools'), ...targets], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.log('Tool update failed.');
      failed = true;
    }
  }
  for (const entry of tools) {
    const was = before.get(entry.name);
    const now = installedToolVersion(entry.pkg);
    if (now && now !== was) {
      console.log(`${entry.name} ${was ?? 'not downloaded'} → ${now}`);
      changed = true;
    }
  }

  const current = cliVersion();
  const latest = latestVersion(CLI_PKG);
  if (!latest) {
    console.log('voidshift: could not check npm');
    failed = true;
  } else if (isNewer(latest, current)) {
    if (fromSource()) {
      console.log(`voidshift ${latest} is out; this copy runs from source, so pull the repo instead.`);
    } else {
      const r = spawnSync('npm', ['install', '-g', ...QUIET, `${CLI_PKG}@${latest}`], { stdio: 'inherit' });
      if (r.status === 0) {
        console.log(`voidshift ${current} → ${latest}`);
        changed = true;
      } else {
        console.log(`voidshift: update failed. Run: npm i -g ${CLI_PKG}@latest`);
        failed = true;
      }
    }
  }

  if (!changed && !failed) console.log(`Already up to date (voidshift ${current}).`);
  return failed ? 1 : 0;
}
