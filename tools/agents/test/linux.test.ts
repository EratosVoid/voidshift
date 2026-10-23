import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyStore, readSecret, readSecretsFile, removeSecret, secretsPath, storeSecret, writeSecretsFile } from '../src/secrets.ts';
import { parseExecStart, quote, serviceUnit, timerUnit, unquote } from '../src/systemd.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'vsf-linux-'));

test('a service unit runs the program once and appends to the log', () => {
  const unit = serviceUnit(['/usr/bin/node', '/opt/vsf/cli.js', 'agents', 'tick'], { PATH: '/usr/bin:/bin', HOME: '/home/v' }, '/home/v/runner.log');
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/vsf\/cli.js" "agents" "tick"$/m);
  assert.match(unit, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/v\/runner.log$/m);
  assert.match(unit, /^TimeoutStartSec=infinity$/m);
});

test('the timer starts the next check a minute after the last one ends', () => {
  assert.match(timerUnit(), /^OnUnitInactiveSec=60s$/m);
  assert.match(timerUnit(), /^WantedBy=timers.target$/m);
});

test('ExecStart words survive the characters systemd expands', () => {
  const words = ['/a b/node', 'say "hi"', '100%', '$HOME', 'back\\slash'];
  assert.deepEqual(parseExecStart(serviceUnit(words, {}, '/l')), words);
  for (const w of words) assert.equal(unquote(quote(w).slice(1, -1)), w);
  assert.deepEqual(parseExecStart('[Service]\n'), []);
});

test('secrets file is written 0600 and refused when others can read it', () => {
  const path = join(scratch(), 'agents', 'secrets.json');
  writeSecretsFile(path, { linear: 'lin_api_abc' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readSecretsFile(path), { linear: 'lin_api_abc' });
  chmodSync(path, 0o644);
  assert.throws(() => readSecretsFile(path), /chmod 600/);
});

test('on Linux keys go to the secrets file, merged with what is there', () => {
  const dir = scratch();
  assert.equal(readSecret(dir, 'linear', 'linux'), null);
  assert.ok(storeSecret(dir, 'linear', 'lin_api_abc', 'linux'));
  assert.ok(storeSecret(dir, 'discord', 'https://discord.com/api/webhooks/1/x', 'linux'));
  assert.equal(readSecret(dir, 'linear', 'linux'), 'lin_api_abc');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(secretsPath(dir), 'utf8'))), ['linear', 'discord']);
  assert.equal(storeSecret(dir, 'linear', 'has space', 'linux'), false);
  assert.equal(keyStore('linux'), 'a file only you can read');
});

test('a name with digits is stored, and removeSecret drops only its own key', () => {
  const dir = scratch();
  assert.ok(storeSecret(dir, 'linear', 'lin_api_abc', 'linux'));
  assert.ok(storeSecret(dir, 'discord-build-2', 'https://discord.com/api/webhooks/1/x', 'linux'));
  assert.equal(readSecret(dir, 'discord-build-2', 'linux'), 'https://discord.com/api/webhooks/1/x');
  assert.ok(removeSecret(dir, 'discord-build-2', 'linux'));
  assert.deepEqual(readSecretsFile(secretsPath(dir)), { linear: 'lin_api_abc' });
  assert.equal(statSync(secretsPath(dir)).mode & 0o777, 0o600);
});
