import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolStatusJson } from '../src/commands/status.ts';

test('toolStatusJson parses only on success', () => {
  assert.deepEqual(toolStatusJson(0, '{"a":1}\n'), { a: 1 });
  assert.deepEqual(toolStatusJson(1, ' boom \n'), { error: 'boom' });
  assert.deepEqual(toolStatusJson(3, ''), { error: 'status exited 3' });
  assert.deepEqual(toolStatusJson(1, '{"a":1}'), { error: '{"a":1}' });
});
