import { context, readConfig, writeConfig } from '../config.ts';
import { fetchTool, loadTool } from '../loader.ts';
import { findTool, registry, type ToolEntry } from '../registry.ts';

export function listTools(): number {
  const installed = new Set(readConfig().tools);
  const width = Math.max(...registry.map((t) => t.name.length));
  for (const t of registry) {
    const tag = installed.has(t.name) ? ' (added)' : t.status === 'planned' ? ' (coming soon)' : '';
    console.log(`${t.name.padEnd(width)}  ${t.summary}${tag}`);
  }
  return 0;
}

function lookup(name: string | undefined, verb: string): ToolEntry | null {
  if (!name) {
    console.error(`usage: voidshift ${verb} <tool>`);
    return null;
  }
  const tool = findTool(name);
  if (!tool) console.error(`unknown tool: ${name}. Run voidshift tools to see the list.`);
  return tool ?? null;
}

export async function addTool(name: string | undefined): Promise<number> {
  const entry = lookup(name, 'add');
  if (!entry) return 2;
  if (entry.status === 'planned') {
    console.error(`${entry.name} is not released yet.`);
    return 1;
  }
  const ctx = context();
  if (!fetchTool(entry, ctx.configDir)) {
    console.error(`could not download ${entry.pkg}`);
    return 1;
  }
  try {
    await (await loadTool(entry, ctx.configDir)).install(ctx);
  } catch (err) {
    console.error(`${entry.name}: ${(err as Error).message}`);
    return 1;
  }
  const config = readConfig();
  if (!config.tools.includes(entry.name)) writeConfig({ ...config, tools: [...config.tools, entry.name] });
  return 0;
}

export async function removeTool(name: string | undefined): Promise<number> {
  const entry = lookup(name, 'remove');
  if (!entry) return 2;
  const ctx = context();
  const config = readConfig();
  if (!config.tools.includes(entry.name)) {
    console.error(`${entry.name} is not added.`);
    return 1;
  }
  await (await loadTool(entry, ctx.configDir)).uninstall(ctx);
  writeConfig({ ...config, tools: config.tools.filter((t) => t !== entry.name) });
  console.log(`${entry.name} removed.`);
  return 0;
}

export async function runToolCommand(entry: ToolEntry, args: string[]): Promise<number> {
  const ctx = context();
  if (!readConfig().tools.includes(entry.name)) {
    console.error(`${entry.name} is not added. Run voidshift add ${entry.name}`);
    return 1;
  }
  const tool = await loadTool(entry, ctx.configDir);
  const [sub, ...rest] = args;
  const command = sub ? tool.commands?.[sub] : undefined;
  if (!command) {
    const names = Object.keys(tool.commands ?? {}).filter((n) => n !== 'tick' && n !== 'recall');
    console.error(`usage: voidshift ${entry.name} <${names.join('|')}>`);
    return 2;
  }
  return command(rest, ctx);
}
