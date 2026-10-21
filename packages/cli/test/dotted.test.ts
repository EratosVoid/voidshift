import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, getPath, mask, maskDeep, parseValue, setPath, unsetPath } from '../src/dotted.ts';

test('getPath walks nested objects', () => {
  const o = { a: { b: { c: 1 } }, list: [1] };
  assert.equal(getPath(o, ['a', 'b', 'c']), 1);
  assert.deepEqual(getPath(o, ['a', 'b']), { c: 1 });
  assert.equal(getPath(o, ['a', 'x', 'c']), undefined);
  assert.equal(getPath(o, ['list', 'length']), undefined);
  assert.equal(getPath(o, []), o);
});

test('setPath creates objects and does not mutate the input', () => {
  const o = { a: 1 };
  const out = setPath(o, ['b', 'c', 'd'], true);
  assert.deepEqual(out, { a: 1, b: { c: { d: true } } });
  assert.deepEqual(o, { a: 1 });
  assert.deepEqual(setPath({ a: 5 }, ['a', 'b'], 1), { a: { b: 1 } });
});

test('unsetPath removes a key and ignores missing ones', () => {
  const o = { a: { b: 1, c: 2 } };
  assert.deepEqual(unsetPath(o, ['a', 'b']), { a: { c: 2 } });
  assert.deepEqual(o, { a: { b: 1, c: 2 } });
  assert.deepEqual(unsetPath(o, ['x', 'y']), o);
});

test('flatten gives dotted leaves and keeps arrays whole', () => {
  assert.deepEqual(flatten({ a: { b: 1 }, c: [1, 2], d: 'x' }), [
    ['a.b', 1],
    ['c', [1, 2]],
    ['d', 'x'],
  ]);
  assert.deepEqual(flatten({ a: 1 }, 'tool'), [['tool.a', 1]]);
  assert.deepEqual(flatten({}), []);
});

test('parseValue reads JSON when it can and falls back to the raw string', () => {
  assert.equal(parseValue('20'), 20);
  assert.equal(parseValue('true'), true);
  assert.deepEqual(parseValue('["a"]'), ['a']);
  assert.equal(parseValue('hello'), 'hello');
  assert.equal(parseValue('"quoted"'), 'quoted');
});

test('mask hides secret-looking keys by their last segment', () => {
  assert.equal(mask('linear.apiKey', 'abc'), '****');
  assert.equal(mask('github.TOKEN', 'abc'), '****');
  assert.equal(mask('a.password', 'abc'), '****');
  assert.equal(mask('keys.name', 'abc'), 'abc');
  assert.equal(mask('battery', 20), 20);
});

test('maskDeep masks nested secrets', () => {
  assert.deepEqual(maskDeep({ a: { apiKey: 'x', n: 1 } }), { a: { apiKey: '****', n: 1 } });
});

test('mask matches whole key segments only', () => {
  for (const k of ['apiKey', 'key', 'accessToken', 'clientSecret', 'x.api_key', 'password', 'passphrase']) assert.equal(mask(k, 'v'), '****', k);
  for (const k of ['maxTokens', 'keywords', 'keyboard', 'tokens']) assert.equal(mask(`a.${k}`, 5), 5, k);
});

test('maskDeep hides the whole subtree under a secret key and walks arrays', () => {
  assert.deepEqual(maskDeep({ secret: { a: 1, b: [2] }, n: 1 }), { secret: '****', n: 1 });
  assert.deepEqual(maskDeep({ list: [{ token: 't', name: 'x' }, 'plain'] }), { list: [{ token: '****', name: 'x' }, 'plain'] });
  assert.deepEqual(maskDeep({ maxTokens: 10, keywords: ['a'], keyboard: 'us' }), { maxTokens: 10, keywords: ['a'], keyboard: 'us' });
  assert.equal(maskDeep({ a: 1 }, 'apiKey'), '****');
});

test('setPath and getPath address array elements by number', () => {
  const o = { homes: [{ dir: 'a' }, { dir: 'b' }] };
  const out = setPath(o, ['homes', '0', 'dir'], 'z');
  assert.deepEqual(out, { homes: [{ dir: 'z' }, { dir: 'b' }] });
  assert.deepEqual(o.homes[0], { dir: 'a' });
  assert.equal(getPath(out, ['homes', '1', 'dir']), 'b');
  assert.equal(getPath(out, ['homes', '5']), undefined);
  assert.deepEqual(unsetPath(o, ['homes', '0']), { homes: [{ dir: 'b' }] });
});
