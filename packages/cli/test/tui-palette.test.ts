import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completion, dynamicEntries, filterPalette, makeEntry, onEnter, parseHelpLines, parseUsages, splitCommand } from '../src/tui/palette.ts';
import { needsTerminal } from '../src/tui/actions.ts';
import { usages } from '../src/commands/help.ts';
import { emptyState } from '../src/tui/data.ts';

test('splitCommand splits words and honours quotes', () => {
  assert.deepEqual(splitCommand('agents retry ENG-1'), ['agents', 'retry', 'ENG-1']);
  assert.deepEqual(splitCommand("config set a.b 'two words'"), ['config', 'set', 'a.b', 'two words']);
  assert.deepEqual(splitCommand('  '), []);
});

test('makeEntry finds the literal prefix and whether it runs alone', () => {
  const a = makeEntry('agents status [--json]');
  assert.equal(a.prefix, 'agents status');
  assert.equal(a.runnable, true);
  const b = makeEntry('agents retry CARD [--workflow W]');
  assert.equal(b.prefix, 'agents retry');
  assert.equal(b.runnable, false);
  const c = makeEntry('config get|set|unset KEY [VALUE]');
  assert.equal(c.prefix, 'config');
  assert.equal(c.runnable, false);
  assert.equal(makeEntry('doctor').runnable, true);
  assert.equal(makeEntry('agents run [CARD] [--workflow W] [--from STEP]').runnable, true);
});

test('help text of the three tool styles becomes command lines', () => {
  const agents = parseHelpLines('agents', 'vsf agents <command>\n\n  status [--json]\n      Runner, current card\n  retry CARD [--workflow W]\n      Queue a parked card again\n');
  assert.deepEqual(agents.map((e) => e.text), ['agents status [--json]', 'agents retry CARD [--workflow W]']);
  assert.equal(agents[0]!.desc, 'Runner, current card');
  const awake = parseHelpLines('awake', 'Usage: vsf awake on [--until TIME | --for DURATION]\nUsage: vsf awake off\n');
  assert.deepEqual(awake.map((e) => e.text), ['awake on [--until TIME | --for DURATION]', 'awake off']);
  const memory = parseHelpLines('memory', 'vsf memory <command>\n  status  The vault, its notes\n  search  Notes for words\n');
  assert.deepEqual(memory.map((e) => e.text), ['memory status', 'memory search']);
  assert.equal(memory[0]!.desc, 'The vault, its notes');
});

test('the umbrella usage table yields every command', () => {
  const texts = parseUsages(usages).map((e) => e.text);
  for (const want of ['setup [tool] [--defaults]', 'status [--json]', 'doctor [--json]', 'update', 'ui', 'config edit [tool]', 'add <tool>']) {
    assert.ok(texts.includes(want), `${want} in ${texts.join(' | ')}`);
  }
});

const entries = [makeEntry('agents retry ENG-1407', 'queue the parked card again', true), makeEntry('agents retry CARD [--workflow W]', 'Queue a card'), makeEntry('agents runs [CARD]', 'Past runs'), makeEntry('doctor [--json]', 'Check this Mac')];

test('filterPalette needs every typed word and ranks prefixes first', () => {
  assert.deepEqual(filterPalette(entries, 'retry eng').map((e) => e.text), ['agents retry ENG-1407']);
  assert.deepEqual(filterPalette(entries, 'agents ru').map((e) => e.text), ['agents runs [CARD]']);
  assert.equal(filterPalette(entries, '').length, 4);
  assert.deepEqual(filterPalette(entries, ':doctor').map((e) => e.text), ['doctor [--json]']);
  assert.equal(filterPalette(entries, 'zzz').length, 0);
  // Description words count after command words.
  assert.deepEqual(filterPalette(entries, 'mac').map((e) => e.text), ['doctor [--json]']);
});

test('enter runs a pick, completes a template, or runs what was typed', () => {
  assert.deepEqual(onEnter(entries[0], 'retry'), { run: ['agents', 'retry', 'ENG-1407'] });
  assert.deepEqual(onEnter(entries[1], 'agents retry'), { fill: 'agents retry ' });
  assert.deepEqual(onEnter(entries[1], 'agents retry ENG-9 --workflow x'), { run: ['agents', 'retry', 'ENG-9', '--workflow', 'x'] });
  assert.deepEqual(onEnter(entries[3], 'doc'), { run: ['doctor'] });
  assert.deepEqual(onEnter(undefined, 'agents status'), { run: ['agents', 'status'] });
  assert.deepEqual(onEnter(undefined, ''), { none: true });
  assert.equal(completion(entries[1]!), 'agents retry ');
  assert.equal(completion(entries[0]!), 'agents retry ENG-1407');
});

test('dynamic picks name parked, live and recent cards', () => {
  const state = {
    ...emptyState(['agents']),
    agents: { runner: 'running' as const, lastTick: null, current: { pid: 1, card: 'ENG-5' }, parked: [{ card: 'ENG-7' }], interrupted: [], workflows: 1, projects: 1 },
    runs: [
      { card: 'ENG-7', stamp: 'a', dir: 'd', logs: [], record: { card: 'ENG-7', title: 't', workflow: 'w', outcome: 'parked' as const, startedAt: 'x', steps: [{ step: 'vs-qa', label: 'QA', startedAt: 'x' }] } },
    ],
  };
  const texts = dynamicEntries(state).map((e) => e.text);
  assert.ok(texts.includes('agents retry ENG-7'));
  assert.ok(texts.includes('agents cancel ENG-5'));
  assert.ok(texts.includes('agents show ENG-7'));
  assert.ok(texts.includes('agents run ENG-7 --from qa'));
});

test('commands that prompt or run in the foreground need the terminal', () => {
  for (const args of [['setup'], ['add', 'awake'], ['remove', 'awake'], ['config', 'edit'], ['agents', 'run', 'ENG-1'], ['agents', 'logs', '-f'], ['agents', 'workflow', 'add'], ['agents', 'workflow', 'rm', 'x']]) {
    assert.equal(needsTerminal(args), true, args.join(' '));
  }
  for (const args of [['status'], ['agents', 'retry', 'ENG-1'], ['agents', 'workflow', 'rm', 'x', '--yes'], ['agents', 'cancel'], ['config', 'set', 'a', '1'], ['update']]) {
    assert.equal(needsTerminal(args), false, args.join(' '));
  }
});
