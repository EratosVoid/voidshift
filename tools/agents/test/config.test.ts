import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, TEMPLATES, agentsDir, defsDir, describeWorkflow, describeSteps, hasWork, isProducer, migrate, readAgentsConfig, resolveStep, writeAgentsConfig, type StepDef } from '../src/config.ts';

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

const cfg = { ...structuredClone(DEFAULTS), models: { dev: 'opus', review: 'sonnet' }, timeoutMinutes: 45 };

test('built-in steps resolve to the config values they always used', () => {
  const dev = resolveStep('vs-dev', cfg);
  assert.deepEqual([dev.model, dev.engine, dev.timeoutMs, dev.write, dev.builtin], ['opus', 'claude', 45 * 60_000, true, 'vs-dev']);
  assert.equal(resolveStep('vs-plan', cfg).write, false);
  assert.equal(resolveStep('vs-plan', cfg).model, 'opus');
  const review = resolveStep('vs-plan-review', cfg);
  assert.deepEqual([review.write, review.model], [false, 'sonnet']);
  assert.equal(resolveStep('vs-qa', cfg).write, true);
  assert.match(dev.prompt(), /RESULT:/);
});

test('a custom step keeps its own engine, model, timeout and write', () => {
  const step: StepDef = { id: 'brief', prompt: 'brief.md', output: 'none', model: 'haiku', timeoutMinutes: 5, engine: 'codex', write: true };
  const r = resolveStep(step, cfg, '/agents/brief');
  assert.deepEqual([r.id, r.label, r.engine, r.model, r.timeoutMs, r.write, r.builtin], ['brief', 'brief', 'codex', 'haiku', 5 * 60_000, true, undefined]);
});

test('a bare custom step falls back by its output', () => {
  assert.equal(resolveStep({ id: 'a', prompt: 'a.md', output: 'none' }, cfg).write, false);
  assert.equal(resolveStep({ id: 'a', prompt: 'a.md', output: 'commits' }, cfg).write, true);
  assert.equal(resolveStep({ id: 'a', prompt: 'a.md', output: 'verdict' }, cfg).model, 'sonnet');
  assert.equal(resolveStep({ id: 'a', prompt: 'a.md', output: 'plan' }, cfg).model, 'opus');
  assert.equal(resolveStep({ id: 'a', prompt: 'a.md', output: 'none' }, cfg).timeoutMs, 45 * 60_000);
});

test('custom producers and labels', () => {
  assert.ok(isProducer({ id: 'p', output: 'plan', prompt: 'p.md' }));
  assert.ok(!isProducer({ id: 'p', output: 'none', prompt: 'p.md' }));
  assert.ok(hasWork({ steps: [{ id: 'c', output: 'commits', prompt: 'c.md' }] }));
  assert.equal(describeSteps(['vs-plan', { id: 'brief', label: 'Brief', output: 'none', prompt: 'b.md' }, { id: 'push', output: 'publish' }]), 'Plan → Brief → push');
});

function configDirWith(saved: string) {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-config-'));
  mkdirSync(agentsDir(configDir), { recursive: true });
  writeFileSync(join(agentsDir(configDir), 'config.json'), saved);
  return configDir;
}

const folderAgent = { triggers: [{ source: 'cron', schedule: '0 5 * * *', task: 'Brief me' }], steps: [{ id: 'brief', prompt: 'brief.md', output: 'none' }], maxRounds: 1, project: 'tether-relay', writeBack: { state: null } };

test('agent folders load into workflows and folders; a broken one is skipped', () => {
  const configDir = configDirWith(readFileSync(new URL('./fixtures/config-relay.json', import.meta.url), 'utf8'));
  mkdirSync(join(defsDir(configDir), 'brief'), { recursive: true });
  writeFileSync(join(defsDir(configDir), 'brief', 'agent.json'), JSON.stringify(folderAgent));
  mkdirSync(join(defsDir(configDir), 'broken'), { recursive: true });
  writeFileSync(join(defsDir(configDir), 'broken', 'agent.json'), '{ nope');
  mkdirSync(join(defsDir(configDir), 'empty'), { recursive: true });
  const config = readAgentsConfig(configDir);
  assert.deepEqual(config.workflows.brief, folderAgent);
  assert.deepEqual(config.folders, { brief: join(defsDir(configDir), 'brief') });
  assert.equal(config.workflows.broken, undefined);
  assert.deepEqual(Object.keys(config.workflows), ['tether-relay-automation', 'tether-relay-qa-only', 'brief']);
});

test('a name config.json uses wins over a folder', () => {
  const configDir = configDirWith(readFileSync(new URL('./fixtures/config-relay.json', import.meta.url), 'utf8'));
  mkdirSync(join(defsDir(configDir), 'tether-relay-qa-only'), { recursive: true });
  writeFileSync(join(defsDir(configDir), 'tether-relay-qa-only', 'agent.json'), JSON.stringify(folderAgent));
  const config = readAgentsConfig(configDir);
  assert.deepEqual(config.workflows['tether-relay-qa-only']?.steps, ['vs-qa']);
  assert.equal(config.folders, undefined);
});

test('saved configs round trip unchanged, and folder workflows are never saved', () => {
  const configDir = configDirWith(readFileSync(new URL('./fixtures/config-relay.json', import.meta.url), 'utf8'));
  const path = join(agentsDir(configDir), 'config.json');
  writeAgentsConfig(configDir, readAgentsConfig(configDir));
  const first = readFileSync(path, 'utf8');
  assert.deepEqual(JSON.parse(first).workflows, JSON.parse(readFileSync(new URL('./fixtures/config-relay.json', import.meta.url), 'utf8')).workflows);
  mkdirSync(join(defsDir(configDir), 'brief'), { recursive: true });
  writeFileSync(join(defsDir(configDir), 'brief', 'agent.json'), JSON.stringify(folderAgent));
  const withFolder = readAgentsConfig(configDir);
  assert.ok(withFolder.workflows.brief);
  writeAgentsConfig(configDir, withFolder);
  const second = readFileSync(path, 'utf8');
  assert.equal(second, first);
  assert.ok(!second.includes('brief'));
  assert.ok(!second.includes('folders'));
});
