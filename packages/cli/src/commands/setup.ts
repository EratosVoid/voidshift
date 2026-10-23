import * as p from '@clack/prompts';
import { baseChecks, run } from '../checks.ts';
import { context, readConfig, writeConfig } from '../config.ts';
import { fetchTool, loadTool } from '../loader.ts';
import { findTool, registry, unavailable, type ToolEntry } from '../registry.ts';
import type { ToolContext } from '../tool.ts';
import { needsTerminal, parseFlags } from './args.ts';
import { usages } from './help.ts';
import { Cancelled } from '../ui.ts';
import { formatChecks } from './doctor.ts';

// Download, install and record one tool. Shared by `vsf setup` and `vsf setup <tool>`.
async function installTool(entry: ToolEntry, ctx: ToolContext): Promise<boolean> {
  if (!fetchTool(entry, ctx.configDir)) {
    p.log.error(`Could not download ${entry.pkg}.`);
    return false;
  }
  try {
    await (await loadTool(entry, ctx.configDir)).install(ctx);
    const tools = readConfig().tools;
    if (!tools.includes(entry.name)) writeConfig({ ...readConfig(), tools: [...tools, entry.name] });
    return true;
  } catch (err) {
    if (err instanceof Cancelled) throw err;
    p.log.error(`${entry.name}: ${(err as Error).message}`);
    return false;
  }
}

// `vsf setup <tool>`: set up or reconfigure just one tool.
async function setupTool(name: string, defaults: boolean): Promise<number> {
  const entry = findTool(name);
  if (!entry) {
    console.error(`unknown tool: ${name}. Run vsf tools to see the list.`);
    return 2;
  }
  if (entry.status === 'planned') {
    console.error(`${entry.name} is not released yet.`);
    return 1;
  }
  p.intro(`VoidShift: ${entry.name}`);
  try {
    if (!(await installTool(entry, context(true, defaults)))) return 1;
  } catch (err) {
    if (err instanceof Cancelled) return 1;
    throw err;
  }
  p.outro(`${entry.name} is set up.`);
  return 0;
}

export async function setupCommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, { defaults: { type: 'boolean' } }, usages.setup!);
  if (!parsed) return 2;
  const [tool, extra] = parsed.positionals;
  if (extra) {
    console.error(`too many arguments.\n\n${usages.setup}`);
    return 2;
  }
  const defaults = parsed.values.defaults === true;
  if (!defaults && needsTerminal('setup', 'Run it in a terminal, or use vsf setup --defaults.')) return 2;
  return tool ? setupTool(tool, defaults) : setup(defaults);
}

// `vsf setup` with no tool: check the machine, pick tools, configure
// each one. Safe to run again; it starts from what is already set up.
export async function setup(defaults = false): Promise<number> {
  p.intro(defaults ? 'VoidShift (defaults)' : 'VoidShift');

  const base = baseChecks(process.platform, process.version, run);
  const line = base.map((c) => `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name}`).join('   ');
  if (base.some((c) => c.status === 'fail')) {
    p.log.error(formatChecks(base.filter((c) => c.status !== 'ok')));
    p.outro('Fix the items above, then run vsf setup again.');
    return 1;
  }
  p.log.info(line);
  for (const c of base.filter((c) => c.status === 'warn')) p.log.warn(`${c.name}: ${c.detail}. ${c.fix ?? ''}`);

  const ctx = context(true, defaults);
  const config = readConfig();
  try {
    const available = registry.filter((t) => !unavailable(t)).map((t) => t.name);
    const picked = defaults
      ? [...new Set([...config.tools.filter((n) => available.includes(n)), ...available])]
      : await p.multiselect<string>({
          message: 'Which tools do you want?',
          options: registry.map((t) => ({
            value: t.name,
            label: t.name,
            hint: unavailable(t) ? `${t.summary} (${unavailable(t)})` : t.summary,
            disabled: !!unavailable(t),
          })),
          initialValues: config.tools.filter((n) => available.includes(n)),
          required: false,
        });
    if (p.isCancel(picked)) throw (p.cancel('Setup cancelled. Nothing was changed.'), new Cancelled());
    if (defaults) p.log.info(`Which tools do you want?  ${picked.join(', ')}`);

    for (const name of config.tools.filter((t) => !picked.includes(t))) {
      const entry = registry.find((t) => t.name === name);
      if (!entry) continue;
      if (!(await ctx.ui.confirm(`Remove ${name}?`, false))) continue;
      p.log.step(name);
      try {
        await (await loadTool(entry, ctx.configDir)).uninstall(ctx);
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        p.log.warn(`${name}: ${(err as Error).message} Removed it from your tools anyway.`);
      }
      writeConfig({ tools: readConfig().tools.filter((t) => t !== name) });
    }

    for (const name of picked) {
      const entry = registry.find((t) => t.name === name);
      if (!entry) continue;
      p.log.step(name);
      await installTool(entry, ctx);
    }
  } catch (err) {
    if (err instanceof Cancelled) return 1;
    throw err;
  }

  p.outro('All set. Run vsf setup any time to change this, or vsf doctor to check it.');
  return 0;
}
