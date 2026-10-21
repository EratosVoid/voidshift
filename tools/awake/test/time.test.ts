import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLeft, minutesLeft, parseFor, parseUntil } from '../src/time.ts';

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

test('minutesLeft rounds up and never goes negative', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(minutesLeft(new Date('2026-10-20T12:10:00Z'), now), 130);
  assert.equal(minutesLeft(new Date('2026-10-20T10:00:30Z'), now), 1);
  assert.equal(minutesLeft(new Date('2026-10-20T09:00:00Z'), now), 0);
});

test('formatLeft reads naturally', () => {
  assert.equal(formatLeft(130), '2h 10m');
  assert.equal(formatLeft(120), '2h');
  assert.equal(formatLeft(45), '45m');
});
