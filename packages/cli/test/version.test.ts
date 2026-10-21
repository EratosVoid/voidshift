import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/version.ts';

test('isNewer compares x.y.z', () => {
  assert.equal(isNewer('0.1.3', '0.1.2'), true);
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.2', '0.1.2'), false);
  assert.equal(isNewer('0.1.1', '0.1.2'), false);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
});
