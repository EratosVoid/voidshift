import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, type AgentsConfig, type Workflow } from '../src/config.ts';
import { duplicateTriggerWarnings, moveKey, parseTrigger, renameKey, validateAgentFolder, validateConfig, validateWorkflow, workflowsUsing } from '../src/manage.ts';

const wf = (o: Partial<Workflow> = {}): Workflow => ({ triggers: [{ source: 'linear', team: 'ENG', label: 'vs-plan' }], steps: ['vs-dev', 'vs-qa'], maxRounds: 3, project: 'p', ...o });
const cfg = { enabled: [] as string[], projects: { p: { path: '/x' } } };

test('validateWorkflow accepts a good workflow', () => {
  assert.deepEqual(validateWorkflow(cfg, wf()), []);
});

test('validateWorkflow names each problem', () => {
  assert.equal(validateWorkflow(cfg, wf({ triggers: [] })).length, 1);
  assert.match(validateWorkflow(cfg, wf({ triggers: [{ source: 'linear', team: '', label: ' ' }] })).join(' '), /no team.*no label/);
  assert.match(validateWorkflow(cfg, wf({ steps: [] })).join(' '), /at least one step/);
  assert.match(validateWorkflow(cfg, wf({ steps: ['nope' as never] })).join(' '), /Unknown step/);
  assert.match(validateWorkflow({ ...cfg, enabled: ['vs-dev'] }, wf()).join(' '), /vs-qa is not enabled/);
  assert.match(validateWorkflow(cfg, wf({ project: 'q' })).join(' '), /does not exist/);
  assert.equal(validateWorkflow(cfg, wf({ maxRounds: 0 })).length, 1);
  assert.equal(validateWorkflow(cfg, wf({ maxRounds: 10 })).length, 1);
  assert.equal(validateWorkflow(cfg, wf({ maxRounds: 2.5 })).length, 1);
});

test('parseTrigger uppercases the team', () => {
  assert.deepEqual(parseTrigger('eng:vs-plan'), { source: 'linear', team: 'ENG', label: 'vs-plan' });
  assert.equal(parseTrigger('ENG'), null);
  assert.equal(parseTrigger(':x'), null);
  assert.equal(parseTrigger('ENG:'), null);
});

test('renameKey keeps the order', () => {
  assert.deepEqual(Object.keys(renameKey({ a: 1, b: 2, c: 3 }, 'b', 'x')), ['a', 'x', 'c']);
  assert.equal(renameKey({ a: 1, b: 2 }, 'b', 'x').x, 2);
});

test('moveKey reorders', () => {
  const r = { a: 1, b: 2, c: 3 };
  assert.deepEqual(Object.keys(moveKey(r, 'c', { first: true })), ['c', 'a', 'b']);
  assert.deepEqual(Object.keys(moveKey(r, 'a', { last: true })), ['b', 'c', 'a']);
  assert.deepEqual(Object.keys(moveKey(r, 'c', { before: 'b' })), ['a', 'c', 'b']);
  assert.deepEqual(Object.keys(moveKey(r, 'a', { after: 'b' })), ['b', 'a', 'c']);
  assert.deepEqual(Object.keys(moveKey(r, 'a', { before: 'zzz' })), ['a', 'b', 'c']);
});

test('workflowsUsing lists by project', () => {
  const c = { workflows: { a: wf(), b: wf({ project: 'q' }), c: wf() } };
  assert.deepEqual(workflowsUsing(c, 'p'), ['a', 'c']);
  assert.deepEqual(workflowsUsing(c, 'z'), []);
});

test('validateConfig checks the whole config', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  mkdirSync(join(repo, '.git'));
  const good: AgentsConfig = { ...structuredClone(DEFAULTS), projects: { p: { path: repo } }, workflows: { w: wf() }, enabled: ['vs-dev', 'vs-qa'], homes: [{ kind: 'claude', dir: '/h' }] };
  assert.deepEqual(validateConfig(good), []);
  assert.match(validateConfig({ ...good, engine: 'x' }).join(' '), /engine/);
  assert.match(validateConfig({ ...good, models: { dev: 1 } }).join(' '), /models/);
  assert.match(validateConfig({ ...good, reviewState: ' ' }).join(' '), /reviewState/);
  assert.match(validateConfig({ ...good, timeoutMinutes: 500 }).join(' '), /timeoutMinutes/);
  assert.match(validateConfig({ ...good, projects: { p: { path: tmpdir() } } }).join(' '), /not a git repository/);
  assert.match(validateConfig({ ...good, workflows: { w: wf({ project: 'zz' }) } }).join(' '), /Workflow w: Project zz/);
  assert.match(validateConfig({ ...good, homes: [{ kind: 'x', dir: 'd' }] }).join(' '), /homes/);
  assert.match(validateConfig({ ...good, enabled: ['vs-nope'] }).join(' '), /enabled/);
  assert.equal(validateConfig('x').length, 1);
});

test('validateConfig only checks repos and steps the write introduces', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  mkdirSync(join(repo, '.git'));
  const moved = join(tmpdir(), 'vsf-gone-folder');
  const saved = { projects: { old: { path: moved }, p: { path: repo } }, workflows: { w: wf({ project: 'p' }) } };
  const next: AgentsConfig = { ...structuredClone(DEFAULTS), projects: saved.projects, workflows: saved.workflows, enabled: ['vs-dev'] };
  // unchanged moved folder and unchanged workflow with a step that is not enabled
  assert.deepEqual(validateConfig(next, saved), []);
  // without a saved config both are problems
  assert.equal(validateConfig(next).length, 2);
  // a new project or a changed path is checked
  assert.match(validateConfig({ ...next, projects: { ...next.projects, fresh: { path: moved } } }, saved).join(' '), /Project fresh.*not a git repository/);
  assert.match(validateConfig({ ...next, projects: { ...next.projects, old: { path: tmpdir() } } }, saved).join(' '), /Project old/);
  // a changed workflow is checked against enabled
  assert.match(validateConfig({ ...next, workflows: { w: wf({ project: 'p', maxRounds: 2 }) } }, saved).join(' '), /vs-qa is not enabled/);
});

test('duplicateTriggerWarnings names the other workflow and the winner', () => {
  const workflows = { a: wf(), b: wf({ triggers: [{ source: 'linear', team: 'ENG', label: 'other' }] }), c: wf() };
  assert.deepEqual(duplicateTriggerWarnings(workflows, 'c', workflows.c), [
    'Warning: a also starts on ENG + vs-plan, and a wins. vsf agents workflow move changes the order.',
  ]);
  assert.deepEqual(duplicateTriggerWarnings(workflows, 'b', workflows.b), []);
  assert.match(duplicateTriggerWarnings(workflows, 'a', workflows.a)[0]!, /c also starts on ENG \+ vs-plan, and a wins/);
});

// An agent folder with agent.json and prompt files, for validateAgentFolder.
function agentFolder(agent: Record<string, unknown> | string, files: Record<string, string> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'vsf-defs-')), 'brief');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), typeof agent === 'string' ? agent : JSON.stringify(agent));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const files = { 'brief.md': 'Write the brief.', 'build.md': 'Build it.\nRESULT: DONE', 'check.md': 'Check it.\nVERDICT: SHIP' };
const agent = (steps: unknown[], o: Record<string, unknown> = {}) => ({ triggers: [{ source: 'cron', schedule: '0 5 * * *', task: 'go' }], steps, maxRounds: 1, project: 'p', ...o });
const folderCfg = { ...cfg, workflows: {} };

test('validateAgentFolder accepts a good folder', () => {
  const dir = agentFolder(agent([{ id: 'brief', prompt: 'brief.md', output: 'none' }, { id: 'build', prompt: 'build.md', output: 'commits' }, { id: 'check', prompt: 'check.md', output: 'verdict', engine: 'codex', model: 'o4', timeoutMinutes: 10 }, { id: 'push', output: 'publish' }, 'vs-qa'], { writeBack: { labels: false, state: null, comment: false } }), files);
  assert.deepEqual(validateAgentFolder(dir, folderCfg), []);
});

test('validateAgentFolder reports each problem', () => {
  const problems = (steps: unknown[], o: Record<string, unknown> = {}) => validateAgentFolder(agentFolder(agent(steps, o), files), folderCfg).join(' ');
  assert.match(problems([{ id: 'a', prompt: 'missing.md', output: 'none' }]), /a prompt .*missing\.md does not exist/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'poem' }]), /a output must be one of/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', skill: 'vs-dev', output: 'none' }]), /exactly one of skill or prompt/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'publish' }]), /takes no skill or prompt/);
  assert.match(problems([{ id: 'a', output: 'none' }]), /exactly one of skill or prompt/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'none' }, { id: 'a', prompt: 'brief.md', output: 'none' }]), /Step id a is used twice/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'none', timeoutMinutes: 0 }]), /timeoutMinutes/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'none', write: 'yes' }]), /write must be true or false/);
  assert.match(problems([{ id: 'a', prompt: 'build.md', output: 'commits', write: false }]), /write cannot be false/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'verdict' }]), /a prompt never asks for a VERDICT: line/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'commits' }]), /a prompt never asks for a RESULT: line/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'none' }], { writeBack: { labels: 'no' } }), /writeBack.labels/);
  assert.match(problems([{ id: 'a', prompt: 'brief.md', output: 'none', engine: 'gpt' }]), /engine/);
  assert.match(problems([{ id: 'vs-dev', prompt: 'build.md', output: 'commits' }]), /built-in step/);
  assert.match(problems([{ id: 'A b', prompt: 'brief.md', output: 'none' }]), /lowercase/);
  assert.match(validateAgentFolder(agentFolder('{ nope' as never), folderCfg).join(' '), /agent\.json/);
});

test('validateAgentFolder flags a name config.json already uses', () => {
  const dir = agentFolder(agent([{ id: 'a', prompt: 'brief.md', output: 'none' }]), files);
  assert.match(validateAgentFolder(dir, { ...folderCfg, workflows: { brief: wf() } }).join(' '), /config\.json already has a workflow named brief/);
  assert.deepEqual(validateAgentFolder(dir, { ...folderCfg, workflows: { brief: wf() }, folders: { brief: dir } }), []);
});
