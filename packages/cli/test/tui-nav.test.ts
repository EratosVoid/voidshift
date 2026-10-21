import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breadcrumb, initialStack, navReducer } from '../src/tui/nav.ts';
import { activeTab, AGENT_TABS, crumbsOf, hintsOf, screens } from '../src/tui/screens.ts';

test('the stack starts at home and pushes screens on top', () => {
  let s = initialStack();
  s = navReducer(s, { type: 'push', id: 'agents', params: { tab: 'agents.runs' } });
  s = navReducer(s, { type: 'push', id: 'agents.log', params: { card: 'ENG-1' } });
  assert.deepEqual(s.map((r) => r.id), ['home', 'agents', 'agents.log']);
  assert.deepEqual(s[2]!.params, { card: 'ENG-1' });
});

test('pop goes back but never removes the first screen', () => {
  let s = navReducer(initialStack(), { type: 'push', id: 'awake' });
  s = navReducer(s, { type: 'pop' });
  assert.deepEqual(s.map((r) => r.id), ['home']);
  assert.equal(navReducer(s, { type: 'pop' }), s);
});

test('pushing the screen you are on does nothing', () => {
  const s = navReducer(initialStack(), { type: 'push', id: 'awake' });
  assert.equal(navReducer(s, { type: 'push', id: 'awake' }), s);
  assert.equal(navReducer(s, { type: 'push', id: 'awake', params: { a: 1 } }).length, 3);
});

test('replace swaps the top and reset starts over', () => {
  let s = navReducer(initialStack(), { type: 'push', id: 'agents', params: { tab: 'agents.runs' } });
  s = navReducer(s, { type: 'replace', id: 'agents', params: { tab: 'agents.homes' } });
  assert.equal(s.length, 2);
  assert.equal(s[1]!.params.tab, 'agents.homes');
  assert.deepEqual(navReducer(s, { type: 'reset', id: 'home' }).map((r) => r.id), ['home']);
});

test('breadcrumb skips home and keeps only the first crumb of lower screens', () => {
  const titles = (r: { id: string; params: Record<string, unknown> }) => crumbsOf(r.id, r.params);
  let s = navReducer(initialStack(), { type: 'push', id: 'agents', params: { tab: 'agents.workflows' } });
  assert.deepEqual(breadcrumb(s, titles), ['Agents', 'Workflows']);
  s = navReducer(s, { type: 'push', id: 'agents.log', params: { card: 'ENG-1412' } });
  assert.deepEqual(breadcrumb(s, titles), ['Agents', 'ENG-1412', 'Log']);
  assert.deepEqual(breadcrumb(initialStack(), titles), []);
});

test('every screen id Home and the agents tabs rely on is registered', () => {
  for (const id of ['home', 'agents', 'agents.runs', 'agents.workflows', 'agents.projects', 'agents.homes', 'settings', 'agents.log', 'agents.workflow.form', 'agents.project.form', 'awake', 'memory', 'checks']) {
    assert.ok(screens[id], id);
  }
  for (const t of AGENT_TABS) assert.ok(screens[t.id], t.id);
});

test('the agents shell follows its tab param', () => {
  assert.equal(activeTab({}).id, 'agents.runs');
  assert.equal(activeTab({ tab: 'settings' }).label, 'Settings');
  assert.equal(activeTab({ tab: 'nope' }).id, 'agents.runs');
  assert.ok(hintsOf('agents', {}).some((h) => h.key === '←→'));
});
