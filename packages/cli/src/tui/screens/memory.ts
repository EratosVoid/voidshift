// Memory: the vault, what is not indexed, and recall per config folder. Try
// and check run the real commands (vsf memory try / check --json); on and off
// run vsf memory on|off DIR.
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { runAction } from '../actions.ts';
import { useData, type MemoryStatus } from '../data.ts';
import { useBackGuard, useEquivalent, useHints, useKeys, useScreen } from '../context.ts';
import { clockOrStamp, plural, tilde, truncate } from '../format.ts';
import { theme } from '../theme.ts';
import { Lines, Panel, seg, TextInput, type Line } from '../widgets.ts';
import type { Screen } from '../screens.ts';
import { scrollBy } from './list-window.ts';

const h = React.createElement;

type Home = MemoryStatus['homes'][number];

export interface VaultProblems {
  unindexed: string[];
  brokenIndex: string[];
  brokenLinks: { note: string; link: string }[];
}

export const kindLabel = (k: string): string => (k === 'codex' ? 'Codex' : 'Claude Code');

export function recallText(recall: string): { text: string; colour: string } {
  if (recall === 'on') return { text: 'recall on', colour: theme.green };
  if (recall === 'other') return { text: 'another hook recalls', colour: theme.yellow };
  return { text: 'recall off', colour: theme.dim };
}

// vsf memory on|off DIR for the chosen home.
export const toggleArgs = (mode: 'on' | 'off', home: Home): string[] => ['memory', mode, home.dir];

export const tryArgs = (prompt: string): string[] => ['memory', 'try', ...(prompt.startsWith('-') ? ['--'] : []), prompt];

export function parseProblems(output: string): VaultProblems | null {
  try {
    const v = JSON.parse(output) as Partial<VaultProblems>;
    return { unindexed: v.unindexed ?? [], brokenIndex: v.brokenIndex ?? [], brokenLinks: v.brokenLinks ?? [] };
  } catch {
    return null;
  }
}

// The problems grouped as the check command groups them.
export function problemLines(p: VaultProblems): Line[] {
  const lines: Line[] = [];
  const group = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push([seg(`${title} (${items.length})`, theme.yellow)]);
    for (const i of items) lines.push([seg(`  ${i}`)]);
  };
  group('Not in INDEX.md, never recalled', p.unindexed);
  group('INDEX.md links to files that do not exist', p.brokenIndex);
  group('[[links]] that match no note', p.brokenLinks.map((l) => `${l.note}: [[${l.link}]]`));
  if (!lines.length) lines.push([seg('Vault looks good. Every note is indexed and every link works.', theme.green)]);
  return lines;
}

export function vaultLines(m: MemoryStatus, now: Date = new Date()): Line[] {
  const label = (t: string) => seg(t.padEnd(14), theme.dim);
  const lines: Line[] = [[label('Vault'), seg(tilde(m.vault))]];
  if (!m.isVault) {
    lines.push([seg('This folder has no INDEX.md, so it is not a vault yet. Run vsf setup memory.', theme.yellow)]);
    return lines;
  }
  lines.push([label('Notes'), seg(`${m.notes}`), seg(`  ${m.indexed} in INDEX.md`, theme.dim)]);
  lines.push([label('Last updated'), seg(m.lastUpdated ? clockOrStamp(new Date(m.lastUpdated), now) : 'never')]);
  if (m.unindexed.count) {
    const names = m.unindexed.names.slice(0, 5).map((n) => truncate(n, 40));
    lines.push([label('Not indexed'), seg(plural(m.unindexed.count, 'note'), theme.yellow), seg('  never recalled. c shows the details', theme.dim)]);
    for (const n of names) lines.push([seg(`  ${n}`, theme.dim)]);
    if (m.unindexed.count > names.length) lines.push([seg(`  +${m.unindexed.count - names.length} more`, theme.dim)]);
  } else lines.push([label('Not indexed'), seg('none', theme.green)]);
  return lines;
}

type Result = { title: string; lines: Line[] };

function Memory(): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const m = state.memory;
  const [sel, setSel] = useState(0);
  const [asking, setAsking] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);

  const homes = m?.homes ?? [];
  const at = Math.min(sel, Math.max(0, homes.length - 1));
  const home = homes[at];

  useBackGuard(() => {
    if (asking) {
      setAsking(false);
      return true;
    }
    if (result) {
      setResult(null);
      return true;
    }
    return false;
  });
  useHints(
    asking
      ? [{ key: 'enter', label: 'try it' }, { key: 'esc', label: 'cancel' }]
      : [{ key: 't', label: 'try a prompt' }, { key: 'c', label: 'check' }, { key: 'o', label: 'recall on' }, { key: 'f', label: 'recall off' }, { key: 'esc', label: 'back' }],
  );
  useEquivalent(asking ? tryArgs(prompt || 'PROMPT') : ['memory', 'status']);

  const runRead = async (args: string[], title: string, shape: (output: string, code: number) => Line[]) => {
    if (busy) return;
    setBusy(true);
    ctx.toast(`Running vsf ${args.join(' ')}`, 'info');
    const r = await runAction(args, { timeoutMs: 60_000 });
    setBusy(false);
    setOffset(0);
    setResult({ title, lines: shape(r.output, r.code) });
  };

  const submitTry = (value: string) => {
    const p = value.trim();
    if (!p) return;
    setAsking(false);
    void runRead(tryArgs(p), `vsf memory try`, (out) => (out ? out.split('\n').map((l) => [seg(l)]) : [[seg('Nothing would be recalled.', theme.dim)]]));
  };

  useKeys(
    (input, key) => {
      if (asking) {
        if (key.escape) setAsking(false);
        return;
      }
      if (key.upArrow) setSel(Math.max(0, at - 1));
      else if (key.downArrow) setSel(Math.min(homes.length - 1, at + 1));
      else if (key.pageUp) setOffset((o) => scrollBy(o, -8, 10000));
      else if (key.pageDown) setOffset((o) => scrollBy(o, 8, 10000));
      else if (input === 't') {
        setPrompt('');
        setAsking(true);
      } else if (input === 'c') {
        void runRead(['memory', 'check', '--json'], 'vsf memory check', (out, code) => {
          const p = parseProblems(out);
          return p ? problemLines(p) : [[seg(out || `Check failed (exit code ${code})`, theme.red)]];
        });
      } else if ((input === 'o' || input === 'f') && home) {
        const mode = input === 'o' ? 'on' : 'off';
        void ctx.actions.run({
          args: toggleArgs(mode, home),
          title: `Turn recall ${mode} in ${kindLabel(home.kind)}?`,
          body:
            mode === 'on'
              ? `Adds the recall hook to ${tilde(home.dir)}, so matching notes are added to your prompts.`
              : `Removes the recall hook from ${tilde(home.dir)}. The skill stays.`,
          confirmLabel: `Turn ${mode}`,
          cancelLabel: 'Leave it',
        });
      }
    },
    { whileCapturing: true },
  );

  if (!m) {
    return h(Box, { paddingX: 1 }, h(Text, { color: state.errors.memory ? theme.red : theme.dim }, state.errors.memory ?? (state.loaded ? 'memory is not added. Run vsf add memory.' : 'Loading...')));
  }

  const size = Math.max(4, ctx.rows - 20);
  return h(
    Box,
    { flexDirection: 'column' },
    h(Panel, { title: 'Memory' }, h(Lines, { lines: vaultLines(m) })),
    h(
      Panel,
      { title: 'Config folders', focused: !result && !asking },
      homes.length === 0 ? h(Text, { color: theme.dim }, 'No config folders saved. Run vsf setup memory.') : null,
      ...homes.map((hm, i) => {
        const r = recallText(hm.recall);
        const on = i === at;
        const bg = on ? theme.selected : undefined;
        return h(
          Box,
          { key: hm.dir, flexDirection: 'row' },
          h(Text, { backgroundColor: bg, color: theme.accent }, on ? '▶ ' : '  '),
          h(Text, { backgroundColor: bg, bold: on }, kindLabel(hm.kind).padEnd(13)),
          h(Text, { backgroundColor: bg, color: theme.dim }, tilde(hm.dir).padEnd(24)),
          h(Text, { backgroundColor: bg, color: r.colour }, r.text.padEnd(22)),
          h(Text, { backgroundColor: bg, color: theme.dim }, `skill ${hm.skill}`),
        );
      }),
    ),
    asking
      ? h(
          Panel,
          { title: 'Try a prompt', focused: true },
          h(Text, { color: theme.dim }, 'Type a prompt to see what recall would add to it. Real sessions are not touched.'),
          h(TextInput, { value: prompt, onChange: setPrompt, onSubmit: submitTry, placeholder: 'e.g. how do we deploy the relay?' }),
        )
      : null,
    result
      ? h(
          Panel,
          { title: result.title, subtitle: 'esc closes', focused: true },
          h(Lines, { lines: result.lines.slice(offset, offset + size) }),
          result.lines.length > offset + size ? h(Text, { color: theme.dim }, `+${result.lines.length - offset - size} more lines, page down`) : null,
        )
      : null,
  );
}

export const memoryScreen: Screen = {
  id: 'memory',
  title: 'Memory',
  component: () => h(Memory),
  hints: () => [{ key: 't', label: 'try a prompt' }, { key: 'c', label: 'check' }, { key: 'o', label: 'recall on' }, { key: 'f', label: 'recall off' }, { key: 'esc', label: 'back' }],
};
