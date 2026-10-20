import { baseChecks, run } from '../checks.ts';
import { context, readConfig } from '../config.ts';
import { loadTool } from '../loader.ts';
import { findTool } from '../registry.ts';
import type { Check } from '../tool.ts';

const mark = { ok: '✓', warn: '!', fail: '✗' } as const;

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => {
      const line = `${mark[c.status]} ${c.name.padEnd(width)}  ${c.detail}`;
      return c.fix && c.status !== 'ok' ? `${line}\n  ${' '.repeat(width)}  ${c.fix}` : line;
    })
    .join('\n');
}

export async function doctor(): Promise<number> {
  const checks = baseChecks(process.platform, process.version, run);
  const ctx = context();
  for (const name of readConfig().tools) {
    const entry = findTool(name);
    if (!entry) continue;
    try {
      checks.push(...(await (await loadTool(entry, ctx.configDir)).checks(ctx)));
    } catch (err) {
      checks.push({ name, status: 'fail', detail: (err as Error).message });
    }
  }
  console.log(formatChecks(checks));
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
