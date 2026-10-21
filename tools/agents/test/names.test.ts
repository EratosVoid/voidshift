import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStep, resolveName } from '../src/names.ts';

test('resolveName takes an exact name or a unique prefix', () => {
  const names = ['tether-relay-build', 'tether-qa', 'site-build'];
  assert.deepEqual(resolveName(names, 'site', 'workflow'), { name: 'site-build' });
  assert.deepEqual(resolveName(names, 'tether-qa', 'workflow'), { name: 'tether-qa' });
  assert.match((resolveName(names, 'tether', 'workflow') as { error: string }).error, /matches tether-relay-build, tether-qa/);
  assert.match((resolveName(names, 'nope', 'workflow') as { error: string }).error, /No workflow named nope/);
});

test('resolveName rejects empty or blank input', () => {
  assert.deepEqual(resolveName(['a'], '', 'project'), { error: 'Give a project name.' });
  assert.deepEqual(resolveName(['a'], '  ', 'workflow'), { error: 'Give a workflow name.' });
});

test('parseStep reads short names, ids and labels', () => {
  assert.equal(parseStep('dev'), 'vs-dev');
  assert.equal(parseStep('vs-qa'), 'vs-qa');
  assert.equal(parseStep('Plan review'), 'vs-plan-review');
  assert.equal(parseStep('plan-review'), 'vs-plan-review');
  assert.equal(parseStep('ship'), null);
});
