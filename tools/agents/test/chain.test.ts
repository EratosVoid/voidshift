import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  findingsFor,
  isRoundLabel,
  latestPlan,
  parseDevResult,
  parseVerdict,
  qaPassed,
  skillBody,
} from '../src/chain.ts';

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

test('findings only carry FIX steps', () => {
  const f = findingsFor([
    { step: 'ci', verdict: 'SHIP', report: 'green' },
    { step: 'review', verdict: 'FIX', report: 'a.ts:3 wrong\nVERDICT: FIX' },
  ]);
  assert.match(f, /### review/);
  assert.doesNotMatch(f, /green/);
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
  assert.match(p, /QA findings to fix\n\na\.ts:1 bad/);
  assert.doesNotMatch(p, /name: vs-dev/);
});
