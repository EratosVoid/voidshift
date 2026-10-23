import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeTool, toolUsage } from '../src/commands/tools.ts';
import type { Tool } from '../src/tool.ts';

const commands = { on: 1, status: 1, tick: 1 };

test('routeTool decides help, unknown or run', () => {
  assert.equal(routeTool(undefined, commands), 'help');
  assert.equal(routeTool('help', commands), 'help');
  assert.equal(routeTool('--help', commands), 'help');
  assert.equal(routeTool('-h', commands), 'help');
  assert.equal(routeTool('on', commands), 'run');
  assert.equal(routeTool('nope', commands), 'unknown');
  assert.equal(routeTool('toString', commands), 'unknown');
  assert.equal(routeTool('on', undefined), 'unknown');
});

test('toolUsage hides internal commands', () => {
  const tool = { commands: { on: async () => 0, tick: async () => 0, recall: async () => 0 } } as unknown as Tool;
  const text = toolUsage('awake', tool);
  assert.match(text, /vsf awake <on>/);
  assert.doesNotMatch(text, /tick|recall/);
});

test('awake is macOS only, the other tools run on Linux', async () => {
  const { registry, unavailable } = await import('../src/registry.ts');
  const awake = registry.find((t) => t.name === 'awake')!;
  assert.equal(unavailable(awake, 'darwin'), null);
  assert.equal(unavailable(awake, 'linux'), 'macOS only');
  for (const t of registry.filter((t) => t.name !== 'awake')) assert.equal(unavailable(t, 'linux'), null);
});

test('a tool built for a newer contract is not loaded, and says to update', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadTool } = await import('../src/loader.ts');
  const { CONTRACT } = await import('../src/tool.ts');
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-contract-'));
  const entry = { name: 'future', summary: '', pkg: '@example/future-tool', status: 'available' as const };
  const dist = join(configDir, 'tools', 'node_modules', entry.pkg, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), `export default { name: 'future', summary: '', contract: ${CONTRACT + 1} };\n`);
  await assert.rejects(loadTool(entry, configDir), /needs a newer vsf.*vsf update/);
  writeFileSync(join(dist, 'index.js'), "export default { name: 'future', summary: '' };\n");
  const { mkdtempSync: m2 } = await import('node:fs');
  const other = m2(join(tmpdir(), 'vsf-contract-'));
  const dist2 = join(other, 'tools', 'node_modules', entry.pkg, 'dist');
  mkdirSync(dist2, { recursive: true });
  writeFileSync(join(dist2, 'index.js'), "export default { name: 'future', summary: '' };\n");
  assert.equal((await loadTool(entry, other)).name, 'future', 'no contract field means 1');
});
