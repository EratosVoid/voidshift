import { baseChecks, run } from '../checks.ts';
import { context, readConfig } from '../config.ts';
import { loadTool } from '../loader.ts';
import { findTool } from '../registry.ts';
import type { Check } from '../tool.ts';
import { CLI_PKG, cliVersion, isNewer } from '../version.ts';
import { parseFlags } from './args.ts';
import { usages } from './help.ts';
import { latestVersion } from './update.ts';

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

export async function doctor(args: string[] = []): Promise<number> {
  const parsed = parseFlags(args, { json: { type: 'boolean' } }, usages.doctor!);
  if (!parsed) return 2;
  if (parsed.values.help) {
    console.log(usages.doctor);
    return 0;
  }
  const checks = baseChecks(process.platform, process.version, run);
  const ctx = context();
  for (const name of readConfig().tools) {
    const entry = findTool(name);
    if (!entry) {
      checks.push({ name: 'config', status: 'warn', detail: `unknown tool ${name} in your config`, fix: `vsf remove ${name}` });
      continue;
    }
    try {
      checks.push(...(await (await loadTool(entry, ctx.configDir)).checks(ctx)));
    } catch (err) {
      checks.push({ name, status: 'fail', detail: (err as Error).message });
    }
  }
  const latest = latestVersion(CLI_PKG);
  if (latest && isNewer(latest, cliVersion())) {
    checks.push({ name: 'VoidShift', status: 'warn', detail: `${latest} is out (you have ${cliVersion()})`, fix: 'vsf update' });
  } else {
    checks.push({ name: 'VoidShift', status: 'ok', detail: cliVersion() });
  }
  const ok = !checks.some((c) => c.status === 'fail');
  console.log(parsed.values.json ? JSON.stringify({ ok, checks }, null, 2) : formatChecks(checks));
  return ok ? 0 : 1;
}
