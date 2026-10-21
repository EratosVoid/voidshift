import { context, readConfig, writeConfig } from '../config.ts';
import { fetchTool, loadTool } from '../loader.ts';
import { findTool, registry, type ToolEntry } from '../registry.ts';
import type { Tool } from '../tool.ts';
import { needsTerminal, wantsHelp } from './args.ts';

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
    console.error(`usage: vsf ${verb} <tool>`);
    return null;
  }
  const tool = findTool(name);
  if (!tool) console.error(`unknown tool: ${name}. Run vsf tools to see the list.`);
  return tool ?? null;
}

export async function addTool(name: string | undefined): Promise<number> {
  if (needsTerminal('add', 'Run it in a terminal.')) return 2;
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
  if (needsTerminal('remove', 'Run it in a terminal.')) return 2;
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

const INTERNAL = ['tick', 'recall', 'steps'];

export function toolUsage(name: string, tool: Tool): string {
  const names = Object.keys(tool.commands ?? {}).filter((n) => !INTERNAL.includes(n));
  return `Usage: vsf ${name} <${names.join('|')}>\n\nvsf ${name} <command> --help shows a command's usage.`;
}

// Decide what `vsf <tool> <sub>` means: help, an unknown command, or run it.
export function routeTool(sub: string | undefined, commands: Record<string, unknown> | undefined): 'help' | 'unknown' | 'run' {
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') return 'help';
  return commands && Object.hasOwn(commands, sub) ? 'run' : 'unknown';
}

// The tool's own help command if it has one, else a generated listing.
export async function toolHelp(entry: ToolEntry, args: string[]): Promise<number> {
  const ctx = context();
  const tool = await loadTool(entry, ctx.configDir);
  if (tool.commands && Object.hasOwn(tool.commands, 'help')) return tool.commands.help!(args, ctx);
  console.log(toolUsage(entry.name, tool));
  return 0;
}

export async function runToolCommand(entry: ToolEntry, args: string[]): Promise<number> {
  const ctx = context();
  const [sub, ...rest] = args;
  // Help never needs the tool to be added; it is fetched as needed.
  const asksHelp = sub === 'help' || sub === '--help' || sub === '-h' || (sub !== undefined && wantsHelp(rest));
  if (!asksHelp && !readConfig().tools.includes(entry.name)) {
    console.error(`${entry.name} is not added. Run vsf add ${entry.name}`);
    return 1;
  }
  const tool = await loadTool(entry, ctx.configDir);
  const route = routeTool(sub, tool.commands);
  if (route === 'help') return toolHelp(entry, sub === undefined ? [] : rest);
  if (route === 'unknown') {
    console.error(`unknown command: ${entry.name} ${sub}\n\n${toolUsage(entry.name, tool)}`);
    return 2;
  }
  // Internal commands are run by schedulers, not people: help shows the tool's usage.
  if (INTERNAL.includes(sub!) && wantsHelp(rest)) {
    console.log(toolUsage(entry.name, tool));
    return 0;
  }
  return tool.commands![sub!]!(rest, ctx);
}
