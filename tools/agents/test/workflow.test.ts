import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  findingsFor,
  isRoundLabel,
  isStatusLabel,
  stageLabels,
  latestPlan,
  parseDevResult,
  parseVerdict,
  qaPassed,
  skillBody,
} from '../src/workflow.ts';

test('verdict: last line wins, unreadable is FIX', () => {
  assert.equal(parseVerdict('looks good\nVERDICT: SHIP'), 'SHIP');
  assert.equal(parseVerdict('VERDICT: SHIP\nwait\nVERDICT: FIX'), 'FIX');
  assert.equal(parseVerdict('nothing to see\nVERDICT: SKIP'), 'SKIP');
  assert.equal(parseVerdict('I think it ships'), 'FIX');
  assert.equal(parseVerdict('verdict: ship'), 'SHIP');
});

test('dev result', () => {
  assert.deepEqual(parseDevResult('did it\nRESULT: DONE'), { status: 'done' });
  assert.deepEqual(parseDevResult('RESULT: BLOCKED needs a product call'), { status: 'blocked', reason: 'needs a product call' });
  assert.equal(parseDevResult('no result line').status, 'blocked');
});

test('qa passes unless something says FIX', () => {
  assert.equal(qaPassed([{ step: 'ci', verdict: 'SHIP', report: '' }, { step: 'ui', verdict: 'SKIP', report: '' }]), true);
  assert.equal(qaPassed([{ step: 'ci', verdict: 'SHIP', report: '' }, { step: 'review', verdict: 'FIX', report: 'x' }]), false);
});

test('findings only carry FIX steps; one failure needs no heading', () => {
  const one = findingsFor([
    { step: 'ci', verdict: 'SHIP', report: 'green' },
    { step: 'review', verdict: 'FIX', report: 'a.ts:3 wrong' },
  ]);
  assert.equal(one, 'a.ts:3 wrong');
  const two = findingsFor([
    { step: 'Plan review', verdict: 'FIX', report: 'x' },
    { step: 'QA', verdict: 'FIX', report: 'y' },
  ]);
  assert.match(two, /### Plan review\n\nx\n\n### QA\n\ny/);
});

test('plain "## Plan" heading is read too', () => {
  assert.equal(latestPlan([{ body: '## Plan\n\nsteps', createdAt: '2026-10-21T10:00:00Z' }]), 'steps');
  assert.equal(latestPlan([{ body: '## Planning notes\nx', createdAt: '2026-10-21T10:00:00Z' }]), null);
});

test('latest plan comment wins, others ignored', () => {
  const plan = latestPlan([
    { body: '## VoidShift plan\nold', createdAt: '2026-10-20T10:00:00Z' },
    { body: 'unrelated', createdAt: '2026-10-20T12:00:00Z' },
    { body: '## VoidShift plan\nnew', createdAt: '2026-10-20T11:00:00Z' },
  ]);
  assert.equal(plan, 'new');
  assert.equal(latestPlan([{ body: 'no plan', createdAt: '2026-10-20T10:00:00Z' }]), null);
});

test('round labels', () => {
  assert.ok(isRoundLabel('vs-dev-v2'));
  assert.ok(isRoundLabel('vs-qa-v10'));
  assert.ok(!isRoundLabel('vs-plan'));
});

test('a card keeps one stage label and one version label', () => {
  const old = ['Feature', 'vs-start', 'vs-working', 'vs-plan-v1', 'vs-qa-v1', 'vs-dev-v1', 'vs-qa-v7', 'vs-v1', 'vs-planning'];
  assert.deepEqual(stageLabels(old, 'vs-start', 'vs-dev', 2), ['Feature', 'vs-dev', 'vs-v2']);
  assert.deepEqual(stageLabels(['Feature', 'vs-dev', 'vs-v2'], 'vs-start', 'vs-qa', 2), ['Feature', 'vs-qa', 'vs-v2']);
  assert.deepEqual(stageLabels(['Feature', 'vs-qa', 'vs-v3'], 'vs-start', 'vs-parked', 3), ['Feature', 'vs-parked', 'vs-v3']);
  assert.deepEqual(stageLabels(['vs-start'], 'vs-start', 'vs-planning'), ['vs-planning']);
});

test('status labels never include the trigger labels people use', () => {
  for (const l of ['vs-planning', 'vs-plan-review', 'vs-dev', 'vs-qa', 'vs-v4', 'vs-parked', 'vs-qa-verified', 'vs-working']) assert.ok(isStatusLabel(l), l);
  for (const l of ['vs-plan', 'vs-start', 'Feature']) assert.ok(!isStatusLabel(l), l);
});

test('prompt inlines the skill body without frontmatter', () => {
  assert.equal(skillBody('---\nname: x\n---\n# Body\ntext'), '# Body\ntext');
  const p = buildPrompt({
    skill: '---\nname: vs-dev\n---\n# Implement',
    card: { identifier: 'ENG-1', title: 'Fix it' },
    plan: 'step 1',
    base: 'main',
    round: 2,
    findings: 'a.ts:1 bad',
  });
  assert.match(p, /^# Implement/);
  assert.match(p, /Card ENG-1: Fix it/);
  assert.match(p, /Round 2\. Base branch: `main`/);
  assert.match(p, /Findings to address\n\na\.ts:1 bad/);
  assert.doesNotMatch(p, /name: vs-dev/);
});

import { fixTarget, planBody, verdictBlock } from '../src/workflow.ts';

const steps = ['vs-plan', 'vs-plan-review', 'vs-dev', 'ci', 'vs-qa-review'];
const verdict = (s: string) => ['vs-plan-review', 'ci', 'vs-qa-review'].includes(s);
const producer = (s: string) => s === 'vs-plan' || s === 'vs-dev';

test('consecutive checks run as one block', () => {
  assert.deepEqual(verdictBlock(steps, 3, verdict), [3, 5]);
  assert.deepEqual(verdictBlock(steps, 1, verdict), [1, 2]);
});

test('a failed check goes back to the nearest producer', () => {
  assert.equal(fixTarget(steps, 1, producer), 0);
  assert.equal(fixTarget(steps, 3, producer), 2);
  assert.equal(fixTarget(['ci', 'vs-qa-review'], 0, producer), -1);
});

test('plan body drops the RESULT line', () => {
  assert.equal(planBody('**Understanding.** x\n\nRESULT: DONE'), '**Understanding.** x');
});
