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
