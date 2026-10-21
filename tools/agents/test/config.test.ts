import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_CHAINS, describeChain, hasWork, migrate } from '../src/config.ts';

test('built-in chains', () => {
  assert.equal(describeChain(BUILT_IN_CHAINS.build!), 'Dev → CI → Code review → Browser check');
  assert.ok(hasWork(BUILT_IN_CHAINS.build!));
  assert.ok(!hasWork(BUILT_IN_CHAINS['review-only']!));
});

test('old team-to-repo configs become projects and build triggers', () => {
  const m = migrate({ engine: 'claude', repos: { PLX: '/code/plexa' }, uiUrls: { PLX: 'http://localhost:3000' }, maxRounds: 3 });
  assert.deepEqual(m.projects, { plexa: { path: '/code/plexa', uiUrl: 'http://localhost:3000' } });
  assert.deepEqual(m.triggers, [{ source: 'linear', team: 'PLX', label: 'vs-plan', chain: 'build', project: 'plexa' }]);
  assert.equal((m as Record<string, unknown>).repos, undefined);
});

test('new configs pass through untouched', () => {
  const c = { triggers: [], projects: {} };
  assert.equal(migrate(c), c);
});
