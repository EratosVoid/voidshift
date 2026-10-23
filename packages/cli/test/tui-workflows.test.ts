import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { matchWarnings, moveArgs, warningText, workflowRows } from '../src/tui/screens/workflows.ts';
import {
  availableSteps, effectiveRounds, formProblems, formReducer, hasProducer, initialForm, makeTrigger, renameArgs, saveArgs, sharedTriggerWarnings,
  summaryLine, workflowFormScreen, sectionsFor, type FormState,
} from '../src/tui/screens/workflow-form.ts';
import { deleteBlock, projectRows } from '../src/tui/screens/projects.ts';
import { expandPath, fieldsFor, moveFocus, projectProblems, projectSaveArgs, repoState } from '../src/tui/screens/project-form.ts';
import { homeRows, homeSummary, linkArgs, unlinkArgs } from '../src/tui/screens/homes.ts';
import { workflowsScreen } from '../src/tui/screens/workflows.ts';
import { homesScreen } from '../src/tui/screens/homes.ts';
import { projectsScreen } from '../src/tui/screens/projects.ts';
import { projectFormScreen } from '../src/tui/screens/project-form.ts';
import type { StepsCatalog, WorkflowItem } from '../src/tui/data.ts';
import { fakeData, newSpy, withFakes } from './tui-helpers.ts';

const catalog: StepsCatalog = {
  steps: [
    { id: 'vs-plan', name: 'plan', label: 'Plan', hint: 'writes a plan', output: 'plan' },
    { id: 'vs-plan-review', name: 'plan-review', label: 'Plan review', hint: 'checks it', output: 'verdict' },
    { id: 'vs-publish', name: 'publish', label: 'Publish', hint: 'pushes', output: 'publish' },
    { id: 'vs-dev', name: 'dev', label: 'Dev', hint: 'implements', output: 'commits' },
    { id: 'vs-qa', name: 'qa', label: 'QA', hint: 'checks', output: 'verdict' },
  ],
  templates: {},
};

const wf = (name: string, labels: string[], steps: string[], project = 'tether-relay', maxRounds = 3): WorkflowItem => ({
  name,
  triggers: labels.map((l) => ({ source: 'linear', team: l.split(':')[0]!, label: l.split(':')[1]! })),
  steps,
  project,
  maxRounds,
});

const workflows = [
  wf('tether-relay-build', ['ENG:vs-plan'], ['vs-dev', 'vs-qa']),
  wf('voidshift-plan', ['ORG:vs-plan'], ['vs-plan', 'vs-plan-review', 'vs-dev', 'vs-qa'], 'voidshift'),
  wf('relay-qa-only', ['ENG:vs-plan'], ['vs-qa'], 'tether-relay', 1),
];

test('shared triggers name the workflow that wins', () => {
  const w = matchWarnings(workflows);
  assert.equal(w.length, 1);
  assert.equal(warningText(w[0]!), 'relay-qa-only also starts on ENG + vs-plan, so tether-relay-build wins.');
  assert.deepEqual(matchWarnings(workflows.slice(0, 2)), []);
});

test('workflow rows follow the mockup', () => {
  const rows = workflowRows(workflows, catalog);
  assert.equal((rows[0]![3] as string), 'Dev → QA');
  assert.equal(rows[0]![2], 'ENG + vs-plan');
  assert.equal(rows[1]![3], 'Plan → Plan review → Dev → QA');
});

test('J and K build the move commands, nothing at the ends', () => {
  assert.deepEqual(moveArgs(workflows, 0, 1), ['agents', 'workflow', 'move', 'tether-relay-build', '--after', 'voidshift-plan']);
  assert.deepEqual(moveArgs(workflows, 2, -1), ['agents', 'workflow', 'move', 'relay-qa-only', '--before', 'voidshift-plan']);
  assert.equal(moveArgs(workflows, 0, -1), null);
  assert.equal(moveArgs(workflows, 2, 1), null);
});

const base: FormState = { name: 'tether-relay-build', triggers: [{ team: 'ENG', label: 'vs-plan' }], steps: ['vs-dev', 'vs-qa'], project: 'tether-relay', rounds: 3 };

test('summary line matches the mockup', () => {
  assert.equal(summaryLine(base, catalog), 'when ENG + vs-plan: Dev → QA in tether-relay, 3 rounds');
  assert.equal(summaryLine({ ...base, steps: ['vs-qa'] }, catalog), 'when ENG + vs-plan: QA in tether-relay, 1 round');
});

test('rounds are fixed at 1 without a producer', () => {
  assert.equal(hasProducer(['vs-qa'], catalog), false);
  assert.equal(hasProducer(['vs-plan'], catalog), true);
  assert.equal(effectiveRounds({ ...base, steps: ['vs-qa'] }, catalog), 1);
  assert.equal(effectiveRounds(base, catalog), 3);
  assert.deepEqual(sectionsFor({ ...base, steps: ['vs-qa'] }, catalog), ['name', 'triggers', 'steps', 'project']);
});

test('reducer edits triggers, steps, rounds', () => {
  let s = formReducer(base, { type: 'addTrigger', trigger: { team: 'ORG', label: 'x' } });
  assert.equal(s.triggers.length, 2);
  s = formReducer(s, { type: 'addTrigger', trigger: { team: 'ORG', label: 'x' } });
  assert.equal(s.triggers.length, 2);
  s = formReducer(s, { type: 'removeTrigger', index: 0 });
  assert.deepEqual(s.triggers, [{ team: 'ORG', label: 'x' }]);
  s = formReducer(s, { type: 'moveStep', index: 0, dir: 1 });
  assert.deepEqual(s.steps, ['vs-qa', 'vs-dev']);
  assert.equal(formReducer(s, { type: 'moveStep', index: 1, dir: 1 }), s);
  s = formReducer(s, { type: 'removeStep', index: 0 });
  assert.deepEqual(s.steps, ['vs-dev']);
  s = formReducer(s, { type: 'addStep', id: 'vs-dev' });
  assert.deepEqual(s.steps, ['vs-dev']);
  assert.equal(formReducer(s, { type: 'rounds', value: 12 }).rounds, 9);
  assert.equal(formReducer(s, { type: 'rounds', value: 0 }).rounds, 1);
});

test('available steps exclude the ones already used', () => {
  assert.deepEqual(availableSteps(base, catalog).map((s) => s.label), ['Plan', 'Plan review', 'Publish']);
});

test('validation catches the problems before saving', () => {
  const names = ['a', 'tether-relay-build'];
  const empty = initialForm(undefined, '', ['p', 'q']);
  assert.deepEqual(formProblems(empty, true, null, names, ['p', 'q']), [
    'Give the workflow a name.',
    'Add at least one trigger (press a on Starts when).',
    'Add at least one step (press + on Steps).',
    'Choose a project.',
  ]);
  assert.deepEqual(formProblems(base, true, null, names, ['tether-relay']), ['A workflow named tether-relay-build already exists.']);
  assert.deepEqual(formProblems(base, false, 'tether-relay-build', names, ['tether-relay']), []);
  assert.deepEqual(formProblems({ ...base, name: 'a' }, false, 'tether-relay-build', names, ['tether-relay']), ['A workflow named a already exists.']);
  assert.ok(formProblems({ ...base, project: 'gone' }, false, 'tether-relay-build', names, ['tether-relay']).includes('Choose a project.'));
});

test('save commands carry full flags', () => {
  assert.deepEqual(saveArgs(base, false, catalog), [
    'agents', 'workflow', 'edit', 'tether-relay-build', '--trigger', 'ENG:vs-plan', '--steps', 'dev,qa', '--project', 'tether-relay', '--rounds', '3',
  ]);
  const two = { ...base, steps: ['vs-plan-review', 'vs-qa'], triggers: [...base.triggers, { team: 'ORG', label: 'b' }] };
  assert.deepEqual(saveArgs(two, true, catalog), [
    'agents', 'workflow', 'add', 'tether-relay-build', '--trigger', 'ENG:vs-plan', '--trigger', 'ORG:b', '--steps', 'plan-review,qa', '--project', 'tether-relay', '--rounds', '1',
  ]);
  assert.deepEqual(renameArgs('a', 'b'), ['agents', 'workflow', 'rename', 'a', 'b']);
});

test('trigger fields make a trigger or complain', () => {
  assert.deepEqual(makeTrigger(' eng ', ' vs-plan '), { trigger: { source: 'linear', team: 'ENG', label: 'vs-plan' } });
  assert.deepEqual(makeTrigger('voidtrack:org', 'vs-start'), { trigger: { source: 'voidtrack', team: 'ORG', label: 'vs-start' } });
  assert.ok('error' in makeTrigger('', 'x'));
  assert.ok('error' in makeTrigger('ENG', ''));
  assert.ok('error' in makeTrigger('E:G', 'x'));
});

test('the form warns about triggers it shares', () => {
  const mine: FormState = { ...base, name: 'new-one' };
  assert.deepEqual(sharedTriggerWarnings(workflows, mine, null), ['new-one also starts on ENG + vs-plan, so tether-relay-build wins.']);
  // editing the first one: relay-qa-only now loses to it
  const w = sharedTriggerWarnings(workflows, base, 'tether-relay-build');
  assert.deepEqual(w, ['relay-qa-only also starts on ENG + vs-plan, so tether-relay-build wins.']);
});

// ---- projects ---------------------------------------------------------------

test('project form checks the path as you type', () => {
  const git = (p: string) => p.endsWith('/repo/.git');
  assert.equal(repoState('', git), 'empty');
  assert.equal(repoState('/tmp/repo', git), 'ok');
  assert.equal(repoState('/tmp/nope', git), 'not-repo');
  assert.equal(expandPath('~/x', '/home/a'), '/home/a/x');
  assert.deepEqual(projectProblems({ name: '', path: '', base: '' }, true, []), ['Give the project a name.', 'Give the path to a git repository.']);
  assert.deepEqual(projectProblems({ name: 'a', path: '/tmp/repo', base: '' }, true, ['a'], git), ['A project named a already exists.']);
  assert.deepEqual(projectProblems({ name: 'a', path: '/tmp/repo', base: '' }, false, ['a'], git), []);
});

test('project save commands', () => {
  assert.deepEqual(projectSaveArgs({ name: 'p', path: '~/r', base: '' }, true), ['agents', 'project', 'add', 'p', '--path', '~/r']);
  assert.deepEqual(projectSaveArgs({ name: 'p', path: '~/r', base: 'staging' }, true), ['agents', 'project', 'add', 'p', '--path', '~/r', '--base', 'staging']);
  assert.deepEqual(projectSaveArgs({ name: 'p', path: '~/r', base: '' }, false), ['agents', 'project', 'edit', 'p', '--path', '~/r', '--base', '']);
  assert.deepEqual(fieldsFor(false), ['path', 'base']);
  assert.equal(moveFocus(fieldsFor(true), 'base', 1), 'name');
  assert.equal(moveFocus(fieldsFor(true), 'name', -1), 'base');
});

test('a project in use cannot be deleted', () => {
  assert.match(deleteBlock({ name: 'p', path: '/x', usedBy: ['a', 'b'] })!, /used by a, b/);
  assert.equal(deleteBlock({ name: 'p', path: '/x', usedBy: [] }), null);
  const rows = projectRows([{ name: 'tether-relay', path: '/x/y', base: 'staging', usedBy: ['a'] }]);
  assert.equal(rows[0]![2], 'PRs into staging');
});

// ---- homes -----------------------------------------------------------------

test('homes are shaped from the json', () => {
  const rows = homeRows([{ kind: 'claude', dir: '/h/.claude', linked: ['vs-dev'], missing: ['vs-qa'], taken: [] }, { nope: 1 }]);
  assert.equal(rows.length, 1);
  assert.equal(homeSummary(rows[0]!), '1 linked, 1 missing');
  assert.deepEqual(linkArgs('~/.codex'), ['agents', 'link', '~/.codex']);
  assert.deepEqual(unlinkArgs('/h'), ['agents', 'unlink', '/h']);
});

// ---- rendering --------------------------------------------------------------

const projects = [
  { name: 'tether-relay', path: '/Users/x/tether-relay', base: 'staging', usedBy: ['tether-relay-build'] },
  { name: 'voidshift', path: '/Users/x/voidshift', usedBy: [] },
];

test('the workflows screen renders the list and warning', () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ workflows, projects, steps: catalog }), React.createElement(workflowsScreen.component, { params: {} })));
  const f = r.lastFrame()!;
  assert.match(f, /Workflows, in match order/);
  assert.match(f, /tether-relay-build/);
  // Cut with an ellipsis, never running into the Project column.
  assert.match(f, /Plan → Plan review → Dev →…\s{2}voidshift/);
  assert.match(f, /relay-qa-only also starts on ENG \+ vs-plan, so tether-relay-build wins/);
  r.unmount();
});

test('n opens the form, e opens it with the name', async () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ workflows, projects, steps: catalog }), React.createElement(workflowsScreen.component, { params: {} })));
  r.stdin.write('n');
  await new Promise((x) => setTimeout(x, 30));
  r.stdin.write('e');
  await new Promise((x) => setTimeout(x, 30));
  assert.deepEqual(spy.pushed, [
    { id: 'agents.workflow.form', params: {} },
    { id: 'agents.workflow.form', params: { name: 'tether-relay-build' } },
  ]);
  r.unmount();
});

test('J runs the move command without a dialog, d asks first', async () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ workflows, projects, steps: catalog }), React.createElement(workflowsScreen.component, { params: {} })));
  r.stdin.write('J');
  await new Promise((x) => setTimeout(x, 30));
  r.stdin.write('d');
  await new Promise((x) => setTimeout(x, 30));
  const [move, del] = spy.ran as { args: string[]; noConfirm?: boolean }[];
  assert.deepEqual(move!.args, ['agents', 'workflow', 'move', 'tether-relay-build', '--after', 'voidshift-plan']);
  assert.equal(move!.noConfirm, true);
  assert.deepEqual(del!.args, ['agents', 'workflow', 'rm', 'tether-relay-build', '--yes']);
  assert.notEqual(del!.noConfirm, true);
  r.unmount();
});

test('the workflow form renders the mockup fields', () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ workflows, projects, steps: catalog }), React.createElement(workflowFormScreen.component, { params: { name: 'tether-relay-build' } })));
  const f = r.lastFrame()!;
  assert.match(f, /Edit workflow/);
  assert.match(f, /Starts when/);
  assert.match(f, /ENG \+ vs-plan/);
  assert.match(f, /1 Dev {2}→ {2}2 QA/);
  assert.match(f, /available: Plan, Plan review, Publish/);
  assert.match(f, /Rounds/);
  assert.match(f, /when ENG \+ vs-plan: Dev → QA in tether-relay, 3 rounds/);
  r.unmount();
});

test('saving an empty new form shows the problems and runs nothing', async () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ workflows, projects, steps: catalog }), React.createElement(workflowFormScreen.component, { params: {} })));
  r.stdin.write('\x13');
  await new Promise((x) => setTimeout(x, 40));
  const f = r.lastFrame()!;
  assert.match(f, /Give the workflow a name/);
  assert.match(f, /Add at least one trigger/);
  assert.equal(spy.ran.length, 0);
  r.unmount();
});

test('projects, project form and homes render', () => {
  const spy = newSpy();
  let r = render(withFakes(spy, fakeData({ projects }), React.createElement(projectsScreen.component, { params: {} })));
  assert.match(r.lastFrame()!, /PRs into staging/);
  assert.match(r.lastFrame()!, /used by tether-relay-build/);
  r.unmount();
  r = render(withFakes(spy, fakeData({ projects }), React.createElement(projectFormScreen.component, { params: { name: 'tether-relay' } })));
  assert.match(r.lastFrame()!, /Edit project/);
  assert.match(r.lastFrame()!, /Base branch/);
  r.unmount();
  r = render(withFakes(spy, fakeData({ homes: [{ kind: 'claude', dir: '/h/.claude', linked: ['vs-dev'], missing: ['vs-qa'], taken: ['vs-plan'] }] }), React.createElement(homesScreen.component, { params: {} })));
  assert.match(r.lastFrame()!, /1 linked, 1 missing, 1 taken by something else/);
  assert.match(r.lastFrame()!, /missing: qa/);
  r.unmount();
});

test('deleting a used project is refused with a message', async () => {
  const spy = newSpy();
  const r = render(withFakes(spy, fakeData({ projects }), React.createElement(projectsScreen.component, { params: {} })));
  r.stdin.write('d');
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(spy.ran.length, 0);
  assert.match(spy.toasts[0]!, /used by tether-relay-build/);
  r.unmount();
});

test('saving keeps VoidTrack and cron triggers in their --trigger form', async () => {
  const { triggerSpec } = await import('../src/tui/screens/workflows.ts');
  assert.equal(triggerSpec({ source: 'voidtrack', team: 'ORG', label: 'vs-start' }), 'voidtrack:ORG:vs-start');
  assert.equal(triggerSpec({ source: 'cron', schedule: '0 5 * * 1', task: 'Tidy: up' }), 'cron:0 5 * * 1:Tidy: up');
  assert.equal(triggerSpec({ source: 'linear', team: 'ENG', label: 'vs-plan' }), 'ENG:vs-plan');
});
