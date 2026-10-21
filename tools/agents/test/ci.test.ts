import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciReport, summarizeChecks } from '../src/git.ts';

// Real `gh pr checks` output from tether-relay PR 1331 (tab separated).
const sample = [
  'Backend Tests\tfail\t3m54s\thttps://github.com/TetherAI-ca/tether-relay/actions/runs/39539333039/job/119023226774\t',
  'Socket Security: Pull Request Alerts\tpass\t3s\thttps://socket.dev\t',
  'Frontend Tests\tpending\t0\thttps://github.com/TetherAI-ca/tether-relay/actions/runs/39539333039/job/119023226793\t',
  'Build Check\tpass\t3m40s\thttps://github.com/TetherAI-ca/tether-relay/actions/runs/39539333039/job/119023226757\t',
  'CodeRabbit\tpass\t0\t\tReview skipped: draft pull request',
].join('\n');

test('summarizes checks into failed, pending and passed', () => {
  const s = summarizeChecks(sample);
  assert.deepEqual(s.failed.map((f) => f.name), ['Backend Tests']);
  assert.deepEqual(s.pending, ['Frontend Tests']);
  assert.equal(s.passed, 3);
});

test('the report lists only failures, once each', () => {
  const r = ciReport(summarizeChecks(sample));
  assert.equal(r, 'CI failed:\n- Backend Tests: https://github.com/TetherAI-ca/tether-relay/actions/runs/39539333039/job/119023226774\nStill running: Frontend Tests.');
  assert.doesNotMatch(r, /Socket|CodeRabbit|Refreshing/);
});
