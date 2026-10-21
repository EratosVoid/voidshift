import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultsUi } from '../src/ui.ts';

test('--defaults answers every prompt that has a default', async () => {
  assert.equal(await defaultsUi.text('Battery level', { initial: '20' }), '20');
  assert.equal(await defaultsUi.confirm('Start the runner?', true), true);
  assert.equal(await defaultsUi.confirm('Add another?', false), false);
  assert.equal(await defaultsUi.select('Steps', [{ value: 'build', label: 'build' }, { value: 'qa-only', label: 'qa-only' }], 'build'), 'build');
  assert.deepEqual(await defaultsUi.multiselect('Agents', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], ['a', 'b']), ['a', 'b']);
  assert.equal(await defaultsUi.search('Repo', [{ value: '/x', label: 'x' }], 'repo', '/x'), '/x');
});
