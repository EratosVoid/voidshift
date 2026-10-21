import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_CHAINS, describeChain, hasWork, migrate } from '../src/config.ts';

test('built-in chains', () => {
  assert.equal(describeChain(BUILT_IN_CHAINS.build!), 'Dev → QA');
  assert.ok(hasWork(BUILT_IN_CHAINS.build!));
  assert.ok(!hasWork(BUILT_IN_CHAINS['qa-only']!));
});

test('old team-to-repo configs become projects and build triggers', () => {
  const m = migrate({ engine: 'claude', repos: { PLX: '/code/plexa' }, uiUrls: { PLX: 'http://localhost:3000' }, maxRounds: 3 });
  assert.deepEqual(m.projects, { plexa: { path: '/code/plexa', uiUrl: 'http://localhost:3000' } });
  assert.deepEqual(m.triggers, [{ source: 'linear', team: 'PLX', label: 'vs-plan', chain: 'build', project: 'plexa' }]);
  assert.equal((m as Record<string, unknown>).repos, undefined);
});

test('new configs pass through', () => {
  assert.deepEqual(migrate({ triggers: [], projects: {} }), { triggers: [], projects: {} });
});

test('old CI and code review steps fold into QA', () => {
  const m = migrate({ chains: { mine: { steps: ['vs-dev', 'ci', 'vs-qa-review', 'vs-qa-ui'], maxRounds: 2 } }, triggers: [{ chain: 'review-only' }], enabled: ['vs-dev', 'vs-qa-review', 'vs-qa-ui'] });
  assert.deepEqual(m.chains, { mine: { steps: ['vs-dev', 'vs-qa'], maxRounds: 2 } });
  assert.equal(m.triggers?.[0]?.chain, 'qa-only');
  assert.deepEqual(m.enabled, ['vs-dev', 'vs-qa']);
});
