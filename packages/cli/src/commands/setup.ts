import * as p from '@clack/prompts';
import { baseChecks, run } from '../checks.ts';
import { context, readConfig, writeConfig } from '../config.ts';
import { fetchTool, loadTool } from '../loader.ts';
import { registry } from '../registry.ts';
import { Cancelled } from '../ui.ts';
import { formatChecks } from './doctor.ts';

// `voidshift` with no arguments: check the machine, pick tools, configure
// each one. Safe to run again; it starts from what is already set up.
export async function setup(defaults = false): Promise<number> {
  p.intro(defaults ? 'VoidShift (defaults)' : 'VoidShift');

  const base = baseChecks(process.platform, process.version, run);
  const line = base.map((c) => `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name}`).join('   ');
  if (base.some((c) => c.status === 'fail')) {
    p.log.error(formatChecks(base.filter((c) => c.status !== 'ok')));
    p.outro('Fix the items above, then run voidshift again.');
    return 1;
  }
  p.log.info(line);
  for (const c of base.filter((c) => c.status === 'warn')) p.log.warn(`${c.name}: ${c.detail}. ${c.fix ?? ''}`);

  const ctx = context(true, defaults);
  const config = readConfig();
  try {
    const available = registry.filter((t) => t.status !== 'planned').map((t) => t.name);
    const picked = defaults
      ? [...new Set([...config.tools, ...available])]
      : await p.multiselect<string>({
          message: 'Which tools do you want?',
          options: registry.map((t) => ({
            value: t.name,
            label: t.name,
            hint: t.status === 'planned' ? `${t.summary} (coming soon)` : t.summary,
            disabled: t.status === 'planned',
          })),
          initialValues: config.tools,
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
      if (!fetchTool(entry, ctx.configDir)) {
        p.log.error(`Could not download ${entry.pkg}.`);
        continue;
      }
      try {
        await (await loadTool(entry, ctx.configDir)).install(ctx);
        const tools = readConfig().tools;
        if (!tools.includes(name)) writeConfig({ tools: [...tools, name] });
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        p.log.error(`${name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    if (err instanceof Cancelled) return 1;
    throw err;
  }

  p.outro('All set. Run voidshift any time to change this, or voidshift doctor to check it.');
  return 0;
}
