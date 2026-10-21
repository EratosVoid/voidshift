import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDir, readConfig } from '../config.ts';
import { flatten, getPath, maskDeep, parseValue, setPath, unsetPath } from '../dotted.ts';
import { loadTool } from '../loader.ts';
import { findTool } from '../registry.ts';
import type { Tool } from '../tool.ts';
import { context } from '../config.ts';
import { parseFlags } from './args.ts';
import { usages } from './help.ts';

type Settings = Record<string, unknown>;
type WithConfig = Tool & { config: NonNullable<Tool['config']> };

// Unknown tools are a usage mistake (2); the rest are plain failures (1).
const UNKNOWN = 'unknown tool: ';

// A tool that is added and keeps settings, or the one-line reason it is not.
async function configTool(name: string): Promise<WithConfig | string> {
  const entry = findTool(name);
  if (!entry) return `${UNKNOWN}${name}. Run vsf tools to see the list.`;
  if (!readConfig().tools.includes(name)) return `${name} is not added. Run vsf add ${name}`;
  const tool = await loadTool(entry, configDir());
  return tool.config ? (tool as WithConfig) : `${name} has no settings to configure.`;
}

// Added tools that keep settings, for the bare listing and for edit.
async function withConfig(): Promise<[string, WithConfig][]> {
  const out: [string, WithConfig][] = [];
  for (const name of readConfig().tools) {
    if (!findTool(name)) continue;
    const t = await configTool(name);
    if (typeof t !== 'string') out.push([name, t]);
  }
  return out;
}

async function show(name: string | undefined, json: boolean): Promise<number> {
  let tools: [string, WithConfig][];
  if (name) {
    const t = await configTool(name);
    if (typeof t === 'string') return fail(t);
    tools = [[name, t]];
  } else {
    tools = await withConfig();
  }
  const all: Record<string, unknown> = {};
  for (const [n, t] of tools) all[n] = maskDeep(t.config.read(configDir()));
  if (json) console.log(JSON.stringify(all, null, 2));
  else for (const [n, v] of Object.entries(all)) for (const [k, leaf] of flatten(v, n)) console.log(`${k} = ${JSON.stringify(leaf)}`);
  return 0;
}

function fail(line: string): number {
  console.error(line);
  return line.startsWith(UNKNOWN) ? 2 : 1;
}

const splitKey = (key: string) => {
  const [tool = '', ...path] = key.split('.');
  return { tool, path };
};

async function get(key: string | undefined): Promise<number> {
  if (!key) return usageError('get needs a KEY.');
  const { tool, path } = splitKey(key);
  const t = await configTool(tool);
  if (typeof t === 'string') return fail(t);
  const value = getPath(t.config.read(configDir()), path);
  if (value === undefined) return fail(`no setting ${key}`);
  const shown = maskDeep(value, path[path.length - 1]);
  console.log(typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2));
  return 0;
}

function usageError(line: string): number {
  console.error(`${line}\n\n${usages.config}`);
  return 2;
}

// Apply a change to a fresh read, then let the tool validate and save it.
async function change(key: string | undefined, apply: (cur: Settings, path: string[]) => Settings, done: string): Promise<number> {
  const { tool, path } = splitKey(key ?? '');
  if (!key || !path.length) return usageError('Give a KEY like <tool>.<setting>.');
  const t = await configTool(tool);
  if (typeof t === 'string') return fail(t);
  const problems = t.config.write(configDir(), apply(t.config.read(configDir()), path));
  if (problems.length) {
    for (const line of problems) console.error(line);
    return 1;
  }
  console.log(done);
  return 0;
}

async function edit(name: string | undefined): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('vsf config edit needs a terminal. Use vsf config set KEY VALUE.');
    return 2;
  }
  let target = name;
  if (!target) {
    const tools = await withConfig();
    if (tools.length !== 1) {
      console.error(tools.length ? `Which tool? Pick one: ${tools.map(([n]) => n).join(', ')}.` : 'No added tool has settings to edit.');
      return tools.length ? 2 : 1;
    }
    target = tools[0]![0];
  }
  const t = await configTool(target);
  if (typeof t === 'string') return fail(t);
  const ctx = context();
  const dir = mkdtempSync(join(tmpdir(), 'vsf-'));
  const file = join(dir, `${target}.json`);
  try {
    const before = JSON.stringify(t.config.read(configDir()), null, 2) + '\n';
    writeFileSync(file, before);
    for (;;) {
      // Through a shell so editors with arguments work ("code --wait").
      const r = spawnSync('/bin/sh', ['-c', '${VISUAL:-${EDITOR:-vi}} "$1"', 'sh', file], { stdio: 'inherit' });
      if (r.error || r.status !== 0) {
        console.error('Editor exited with an error, nothing saved.');
        return 1;
      }
      const after = readFileSync(file, 'utf8');
      if (after === before) {
        console.log('No changes.');
        return 0;
      }
      let problems: string[];
      try {
        const value = JSON.parse(after) as unknown;
        problems = typeof value === 'object' && value !== null && !Array.isArray(value) ? t.config.write(configDir(), value as Settings) : ['The settings must be a JSON object.'];
      } catch (err) {
        problems = [`Not valid JSON: ${(err as Error).message}`];
      }
      if (!problems.length) {
        console.log(`Saved ${target} config.`);
        return 0;
      }
      for (const line of problems) console.error(line);
      if (!process.stdin.isTTY || !(await ctx.ui.confirm('Edit again?', true))) return 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function config(args: string[]): Promise<number> {
  const parsed = parseFlags(args, { json: { type: 'boolean' } }, usages.config!);
  if (!parsed) return 2;
  if (parsed.values.help) {
    console.log(usages.config);
    return 0;
  }
  const [sub, a, b, extra] = parsed.positionals;
  switch (sub) {
    case 'get':
      return get(a);
    case 'set':
      if (a === undefined || b === undefined || extra !== undefined) return usageError('set needs a KEY and one VALUE.');
      return change(a, (cur, path) => setPath(cur, path, parseValue(b)), `${a} = ${JSON.stringify(maskDeep(parseValue(b), a.split('.').pop()))}`);
    case 'unset':
      return change(a, (cur, path) => unsetPath(cur, path), `${a} unset`);
    case 'edit':
      return edit(a);
    default:
      return show(sub, parsed.values.json === true);
  }
}
