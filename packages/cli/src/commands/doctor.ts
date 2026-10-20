import { baseChecks, run } from '../checks.ts';
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

export function doctor(): number {
  const checks = baseChecks(process.platform, process.version, run);
  console.log(formatChecks(checks));
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
