import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFor, parseUntil } from '../src/time.ts';

const now = new Date(2026, 9, 20, 22, 15);

test('until a morning time rolls to tomorrow', () => {
  const at = parseUntil('7am', now);
  assert.deepEqual([at?.getDate(), at?.getHours(), at?.getMinutes()], [21, 7, 0]);
});

test('until a later time today stays today', () => {
  const at = parseUntil('23:30', now);
  assert.deepEqual([at?.getDate(), at?.getHours(), at?.getMinutes()], [20, 23, 30]);
});

test('12am and 12pm', () => {
  assert.equal(parseUntil('12am', now)?.getHours(), 0);
  assert.equal(parseUntil('12pm', now)?.getHours(), 12);
});

test('bad until inputs', () => {
  for (const s of ['25:00', '13pm', '7:75', 'soon', '']) assert.equal(parseUntil(s, now), null, s);
});

test('for durations', () => {
  assert.equal(parseFor('6h', now)?.getTime(), now.getTime() + 6 * 3600_000);
  assert.equal(parseFor('90m', now)?.getTime(), now.getTime() + 90 * 60_000);
  assert.equal(parseFor('1h30m', now)?.getTime(), now.getTime() + 90 * 60_000);
  for (const s of ['', '0m', 'h', '6']) assert.equal(parseFor(s, now), null, s);
});
