import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sudoersRule, watchdogPlist } from '../src/system.ts';

test('sudoers rule allows only the two pmset calls for one user', () => {
  assert.equal(
    sudoersRule('aneesh'),
    'aneesh ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n',
  );
});

test('sudoers rule refuses user names that could inject', () => {
  for (const u of ['ALL', 'a b', 'a,b', 'x\nALL ALL=(ALL) ALL', '']) {
    assert.throws(() => sudoersRule(u), u);
  }
});

test('watchdog plist runs the CLI tick every minute and escapes paths', () => {
  const plist = watchdogPlist(['/usr/local/bin/node', '/a&b/main.js', 'awake', 'tick'], '/tmp/w.log');
  assert.match(plist, /<string>\/a&amp;b\/main\.js<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /<string>tick<\/string>/);
});
