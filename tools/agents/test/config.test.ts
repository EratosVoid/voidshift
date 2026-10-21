import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, describeWorkflow, describeSteps, hasWork, migrate } from '../src/config.ts';

test('templates', () => {
  assert.equal(describeSteps(TEMPLATES.build!.steps), 'Dev → QA');
  assert.ok(hasWork(TEMPLATES.build!));
  assert.ok(!hasWork(TEMPLATES['qa-only']!));
});

test('a workflow reads as trigger, steps, project', () => {
  const c = { triggers: [{ source: 'linear' as const, team: 'PLX', label: 'vs-plan' }], steps: TEMPLATES.build!.steps, maxRounds: 3, project: 'plexa' };
  assert.equal(describeWorkflow(c), 'when PLX + vs-plan: Dev → QA in plexa');
});

test('old team-to-repo configs become a workflow that owns its trigger', () => {
  const m = migrate({ engine: 'claude', repos: { PLX: '/code/plexa' }, maxRounds: 3 });
  assert.deepEqual(m.projects, { plexa: { path: '/code/plexa' } });
  assert.deepEqual(m.workflows, {
    'plexa-build': { triggers: [{ source: 'linear', team: 'PLX', label: 'vs-plan' }], steps: ['vs-dev', 'vs-qa'], maxRounds: 3, project: 'plexa' },
  });
  assert.equal((m as Record<string, unknown>).repos, undefined);
});

test('dead browser-check settings are dropped', () => {
  const m = migrate({ models: { dev: 'opus', review: 'sonnet', ui: 'sonnet' }, projects: { a: { path: '/a', base: 'main', uiUrl: 'http://x' } }, uiUrls: { ENG: 'http://y' } });
  assert.deepEqual(m.models, { dev: 'opus', review: 'sonnet' });
  assert.deepEqual(m.projects, { a: { path: '/a', base: 'main' } });
  assert.equal((m as Record<string, unknown>).uiUrls, undefined);
});

test('separate triggers fold into workflows, two teams on one workflow', () => {
  const m = migrate({
    projects: { relay: { path: '/code/relay' } },
    chains: { mine: { steps: ['vs-dev', 'ci', 'vs-qa-review'], maxRounds: 2 } },
    triggers: [
      { source: 'linear', team: 'ENG', label: 'vs-plan', chain: 'mine', project: 'relay' },
      { source: 'linear', team: 'AAI', label: 'vs-plan', chain: 'mine', project: 'relay' },
      { source: 'linear', team: 'ENG', label: 'vs-review', chain: 'review-only', project: 'relay' },
    ],
    enabled: ['vs-dev', 'vs-qa-review', 'vs-qa-ui'],
  });
  assert.deepEqual(m.workflows?.['relay-mine'], {
    triggers: [{ source: 'linear', team: 'ENG', label: 'vs-plan' }, { source: 'linear', team: 'AAI', label: 'vs-plan' }],
    steps: ['vs-dev', 'vs-qa'],
    maxRounds: 2,
    project: 'relay',
  });
  assert.deepEqual(m.workflows?.['relay-qa-only']?.steps, ['vs-qa']);
  assert.deepEqual(m.enabled, ['vs-dev', 'vs-qa']);
  assert.equal((m as Record<string, unknown>).triggers, undefined);
});

test('current configs pass through, old "chains" key is read', () => {
  const workflows = { a: { triggers: [], steps: ['vs-qa'], maxRounds: 1, project: 'p' } };
  assert.deepEqual(migrate({ projects: {}, workflows }).workflows, workflows);
  assert.deepEqual(migrate({ projects: {}, chains: workflows }).workflows, workflows);
});
