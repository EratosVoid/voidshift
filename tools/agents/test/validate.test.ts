import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agents from '../src/index.ts';
import { DEFAULTS, defsDir, writeAgentsConfig } from '../src/config.ts';
import { parseFrom } from '../src/names.ts';
import { readSecret, storeSecret } from '../src/secrets.ts';
import type { ToolContext } from '../src/types.ts';

function ctxFor() {
  const configDir = mkdtempSync(join(tmpdir(), 'vsf-validate-'));
  const repo = mkdtempSync(join(tmpdir(), 'vsf-repo-'));
  mkdirSync(join(repo, '.git'));
  writeAgentsConfig(configDir, { ...structuredClone(DEFAULTS), projects: { p: { path: repo } } });
  const logs: string[] = [];
  const ctx = { configDir, log: (l: string) => void logs.push(l), selfCommand: [] } as unknown as ToolContext;
  return { ctx, configDir, logs };
}

function folder(configDir: string, name: string, steps: unknown[]) {
  const dir = join(defsDir(configDir), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ triggers: [{ source: 'cron', schedule: '0 5 * * *', task: 'go' }], steps, maxRounds: 1, project: 'p' }));
  writeFileSync(join(dir, 'brief.md'), 'Write the brief.');
  return dir;
}

test('vsf agents validate DIR exits 1 with a line per problem, 0 for a good folder', async () => {
  const { ctx, configDir, logs } = ctxFor();
  const bad = folder(configDir, 'bad', [{ id: 'a', prompt: 'nope.md', output: 'none' }, { id: 'push', output: 'publish', prompt: 'brief.md' }]);
  assert.equal(await agents.commands!.validate!([bad], ctx), 1);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => l.startsWith('bad: ')), logs.join('\n'));
  logs.length = 0;
  const good = folder(configDir, 'good', [{ id: 'brief', prompt: 'brief.md', output: 'none' }]);
  assert.equal(await agents.commands!.validate!([good], ctx), 0);
  assert.deepEqual(logs, ['good is valid.']);
});

test('vsf agents validate with no folder checks the config and every folder', async () => {
  const { ctx, configDir, logs } = ctxFor();
  folder(configDir, 'good', [{ id: 'brief', prompt: 'brief.md', output: 'none' }]);
  assert.equal(await agents.commands!.validate!([], ctx), 0, logs.join('\n'));
  folder(configDir, 'bad', [{ id: 'a', output: 'none' }]);
  assert.equal(await agents.commands!.validate!([], ctx), 1);
  assert.ok(logs.some((l) => /^bad: a needs exactly one of skill or prompt/.test(l)), logs.join('\n'));
});

test('folder workflows cannot be edited from the CLI', async () => {
  const { ctx, configDir, logs } = ctxFor();
  folder(configDir, 'good', [{ id: 'brief', prompt: 'brief.md', output: 'none' }]);
  assert.equal(await agents.commands!.workflow!(['rm', 'good', '--yes'], ctx), 1);
  assert.match(logs.at(-1)!, /good is defined in .*agent\.json; edit that file\./);
});

test('--from takes built-in step names and any custom step id', () => {
  assert.equal(parseFrom('dev'), 'vs-dev');
  assert.equal(parseFrom('Plan review'), 'vs-plan-review');
  assert.equal(parseFrom('brief'), 'brief');
  assert.equal(parseFrom('a b'), null);
});

test('vsf agents run --from with a bad step id says Unknown step and exits 2', async () => {
  const { ctx, logs } = ctxFor();
  assert.equal(await agents.commands!.run!(['ENG-1', '--from', 'a b'], ctx), 2);
  assert.match(logs.join('\n'), /Unknown step a b/);
});

test('vsf agents discord refuses a URL on the command line and stores nothing', async () => {
  const { ctx, configDir, logs } = ctxFor();
  assert.equal(await agents.commands!.discord!(['https://discord.com/api/webhooks/1/x'], ctx), 2);
  assert.match(logs.join('\n'), /not accepted on the command line/);
  assert.equal(readSecret(configDir, 'discord'), null);
});

test('a workflow keeps its webhook through a rename, and rm drops it', async () => {
  if (process.platform === 'darwin') return;
  const { ctx, configDir, logs } = ctxFor();
  const flow = { triggers: [{ source: 'cron', schedule: '0 5 * * *', task: 'go' }], steps: ['vs-qa'], maxRounds: 1, project: 'p' };
  writeAgentsConfig(configDir, { ...structuredClone(DEFAULTS), projects: { p: { path: mkdtempSync(join(tmpdir(), 'vsf-repo-')) } }, workflows: { build: flow, other: flow } } as never);
  storeSecret(configDir, 'discord-build', 'https://discord.com/api/webhooks/1/x');
  assert.equal(await agents.commands!.workflow!(['rename', 'build', 'Other'], ctx), 1);
  assert.match(logs.at(-1)!, /would share a webhook/);
  assert.equal(await agents.commands!.workflow!(['rename', 'build', 'make'], ctx), 0, logs.join('\n'));
  assert.equal(readSecret(configDir, 'discord-build'), null);
  assert.equal(readSecret(configDir, 'discord-make'), 'https://discord.com/api/webhooks/1/x');
  assert.equal(await agents.commands!.workflow!(['rm', 'make', '--yes'], ctx), 0, logs.join('\n'));
  assert.equal(readSecret(configDir, 'discord-make'), null);
});
