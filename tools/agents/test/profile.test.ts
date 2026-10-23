import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPolicy, enforceCommitPolicy } from '../src/git.ts';
import { engineArgs } from '../src/engine.ts';
import { claudeSettingsFile, initProfile, profileChecks, profileDir, readRules, renderClaudeSettings, rulesSection } from '../src/profile.ts';
import { validateConfig } from '../src/manage.ts';
import { DEFAULTS, agentsDir } from '../src/config.ts';

const AI = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'vsf-policy-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Dev One');
  git('config', 'user.email', 'dev@example.com');
  const save = (file: string, message: string) => {
    writeFileSync(join(dir, file), file);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, save };
}

test('applyPolicy drops AI lines and signs off once', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vsf-msg-'));
  const signer = 'Dev One <dev@example.com>';
  const out = applyPolicy(`Fix the thing\n\nBody line.\n\n${AI}\n`, { signOff: true, dropAiTrailers: true }, signer, cwd);
  assert.equal(out, `Fix the thing\n\nBody line.\n\nSigned-off-by: ${signer}\n`);
  assert.equal(applyPolicy(out, { signOff: true, dropAiTrailers: true }, signer, cwd), out, 'idempotent');
  assert.equal(applyPolicy('Keep me\n\nCo-Authored-By: Jane <j@x.io>\n', { dropAiTrailers: true }, null, cwd), 'Keep me\n\nCo-Authored-By: Jane <j@x.io>\n', 'humans stay');
});

test('enforceCommitPolicy rewrites only the new commits and keeps every tree', () => {
  const { dir, git, save } = repo();
  const pushed = save('a.txt', `Already pushed\n\n${AI}`);
  save('b.txt', `New one\n\n${AI}`);
  save('c.txt', 'New two');
  const treeBefore = git('rev-parse', 'HEAD^{tree}');
  const changed = enforceCommitPolicy(dir, pushed, { signOff: true, dropAiTrailers: true });
  assert.equal(changed, 2);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), treeBefore);
  assert.equal(git('rev-parse', 'HEAD~2'), pushed, 'the pushed commit is untouched');
  const messages = git('log', '--format=%B%x1e', `${pushed}..HEAD`);
  assert.ok(!messages.includes('Co-Authored-By'));
  assert.equal(messages.split('Signed-off-by: Dev One <dev@example.com>').length - 1, 2);
  assert.equal(git('log', '-1', '--format=%an', 'HEAD'), 'Dev One');
  assert.equal(git('status', '--porcelain'), '', 'working tree clean');
  assert.equal(enforceCommitPolicy(dir, pushed, { signOff: true, dropAiTrailers: true }), 0, 'nothing left to change');
});

test('with the policy off, commits are left alone', () => {
  const { dir, git, save } = repo();
  const first = save('a.txt', 'One');
  save('b.txt', `Two\n\n${AI}`);
  const head = git('rev-parse', 'HEAD');
  assert.equal(enforceCommitPolicy(dir, first, {}), 0);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('Claude runs get the profile settings file', () => {
  const args = engineArgs({ engine: 'claude', cwd: '/w', prompt: 'p', write: true, logFile: '/l', settingsFile: '/run/claude-settings.json' }, '/o').args;
  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), ['--settings', '/run/claude-settings.json']);
  assert.ok(!engineArgs({ engine: 'claude', cwd: '/w', prompt: 'p', write: true, logFile: '/l' }, '/o').args.includes('--settings'));
});

test('profile: rules, settings with {{profile}}, and a broken file reported', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-profile-'));
  assert.deepEqual(profileChecks(configDir), [], 'no profile, no check');
  assert.equal(readRules(configDir), '');
  assert.equal(rulesSection(''), '');
  assert.deepEqual(initProfile(configDir), ['RULES.md']);
  assert.deepEqual(initProfile(configDir), [], 'existing files are kept');
  assert.equal(profileChecks(configDir)[0]?.status, 'warn', 'only the starter comment');
  const dir = profileDir(configDir);
  writeFileSync(join(dir, 'RULES.md'), 'No long dashes.');
  writeFileSync(join(dir, 'claude-settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash {{profile}}/hooks/guard.sh' }] }] } }));
  assert.match(rulesSection(readRules(configDir)), /# Your rules[\s\S]*No long dashes\./);
  const runDir = mkdtempSync(join(tmpdir(), 'vsf-run-'));
  const file = claudeSettingsFile(configDir, runDir)!;
  assert.ok(readFileSync(file, 'utf8').includes(`bash ${dir}/hooks/guard.sh`));
  assert.deepEqual(profileChecks(configDir)[0], { name: 'agent profile', status: 'ok', detail: 'rules, Claude settings' });
  writeFileSync(join(dir, 'claude-settings.json'), '[1]');
  assert.throws(() => renderClaudeSettings(configDir), /JSON object/);
  assert.equal(profileChecks(configDir)[0]?.status, 'fail');
});

test('config accepts a commit policy and refuses anything else there', () => {
  mkdirSync(agentsDir(mkdtempSync(join(tmpdir(), 'vsf-cfg-'))), { recursive: true });
  const base = { ...structuredClone(DEFAULTS) };
  assert.deepEqual(validateConfig({ ...base, commits: { signOff: true, dropAiTrailers: true } }), []);
  assert.equal(validateConfig({ ...base, commits: { signoff: true } }).length, 1);
  assert.equal(validateConfig({ ...base, commits: { signOff: 'yes' } }).length, 1);
});
