import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const main = new URL('../src/main.ts', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'vsf-steps-'));
writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: ['agents'] }));
const vsf = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', env: { ...process.env, VOIDSHIFT_HOME: home } });

test('the hidden agents steps command prints the step list and templates for the forms', () => {
  const r = vsf('agents', 'steps');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { steps: { id: string; name: string; label: string; hint: string; output: string }[]; templates: Record<string, { steps: string[]; maxRounds: number }> };
  assert.deepEqual(out.steps.map((s) => s.name), ['plan', 'plan-review', 'publish', 'dev', 'qa']);
  assert.equal(out.steps[3]!.id, 'vs-dev');
  assert.equal(out.steps[3]!.label, 'Dev');
  assert.deepEqual(out.templates.build, { steps: ['vs-dev', 'vs-qa'], maxRounds: 3 });
});

test('steps is hidden from the tool usage like tick', () => {
  const usage = vsf('agents', 'steps', '--help').stdout;
  assert.match(usage, /^Usage: vsf agents </);
  assert.ok(!/\bsteps\b/.test(usage.split('\n')[0]!), usage);
  assert.ok(!/\btick\b/.test(usage.split('\n')[0]!));
});
