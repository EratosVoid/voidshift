import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addHook, hasOurHook, otherRecall, recallCommand, removeHook } from '../src/hooks.ts';

const home = () => ({ kind: 'claude' as const, dir: mkdtempSync(join(tmpdir(), 'home-')) });

test('the hook is added once and removed cleanly, other settings kept', () => {
  const h = home();
  writeFileSync(join(h.dir, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }));
  const cmd = recallCommand(['/usr/bin/node', '/opt/voidshift/main.js']);
  addHook(h, cmd);
  addHook(h, cmd);
  const s = JSON.parse(readFileSync(join(h.dir, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, '/usr/bin/node /opt/voidshift/main.js memory recall');
  assert.ok(hasOurHook(h));
  removeHook(h);
  const after = JSON.parse(readFileSync(join(h.dir, 'settings.json'), 'utf8'));
  assert.equal(after.hooks.UserPromptSubmit, undefined);
  assert.equal(after.hooks.Stop.length, 1);
  const lone = home();
  addHook(lone, cmd);
  removeHook(lone);
  assert.deepEqual(JSON.parse(readFileSync(join(lone.dir, 'settings.json'), 'utf8')), {});
});

test('another memory hook is noticed, ours is not', () => {
  const h = home();
  writeFileSync(join(h.dir, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/.voidlens/hooks/inject.sh' }] }] } }));
  assert.equal(otherRecall(h), 'bash ~/.voidlens/hooks/inject.sh');
  const fresh = home();
  addHook(fresh, recallCommand(['node', 'main.js']));
  assert.equal(otherRecall(fresh), undefined);
});

test('paths with spaces are quoted', () => {
  assert.equal(recallCommand(['/Users/a b/node', 'main.js']), `'/Users/a b/node' main.js memory recall`);
});
