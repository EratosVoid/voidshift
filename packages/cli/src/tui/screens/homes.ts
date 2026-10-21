// Agents, Homes: the Claude Code and Codex config folders the agents are
// linked into. l and u run `vsf agents link DIR` and `vsf agents unlink DIR`.
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useData, type HomeItem } from '../data.ts';
import { useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { tilde } from '../format.ts';
import { theme } from '../theme.ts';
import { Panel, TextInput } from '../widgets.ts';
import type { Screen } from '../screens.ts';

const h = React.createElement;

export interface HomeRow {
  kind: string;
  dir: string;
  linked: string[];
  missing: string[];
  taken: string[];
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// The homes --json shape, made safe to draw.
export function homeRows(homes: HomeItem[]): HomeRow[] {
  return homes
    .filter((x) => typeof x.dir === 'string')
    .map((x) => ({ kind: typeof x.kind === 'string' ? x.kind : 'claude', dir: x.dir as string, linked: list(x.linked), missing: list(x.missing), taken: list(x.taken) }));
}

const short = (id: string) => id.replace(/^vs-/, '');

// "3 linked, 1 missing, 1 taken by something else"
export function homeSummary(r: HomeRow): string {
  const parts = [`${r.linked.length} linked`];
  if (r.missing.length) parts.push(`${r.missing.length} missing`);
  if (r.taken.length) parts.push(`${r.taken.length} taken by something else`);
  return parts.join(', ');
}

export const linkArgs = (dir: string): string[] => ['agents', 'link', dir];
export const unlinkArgs = (dir: string): string[] => ['agents', 'unlink', dir];

const LIST_HINTS: Hint[] = [
  { key: 'l', label: 'link a folder' },
  { key: 'u', label: 'unlink' },
  { key: 'esc', label: 'back' },
];

function Homes(): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const rows = homeRows(state.homes);
  const [sel, setSel] = useState(0);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const index = Math.max(0, Math.min(sel, rows.length - 1));
  const current = rows[index];

  useHints(adding ? [{ key: 'enter', label: 'link' }, { key: 'esc', label: 'cancel' }] : LIST_HINTS);
  useEquivalent(adding ? (path.trim() ? linkArgs(path.trim()) : null) : current ? unlinkArgs(current.dir) : null);

  const link = async () => {
    const dir = path.trim();
    if (!dir) return;
    const r = await ctx.actions.run({
      args: linkArgs(dir),
      title: 'Link the agents into this folder?',
      body: `${tilde(dir)}\nThe agents are added as skills in it. Anything already there is left alone.`,
      confirmLabel: 'Link',
      done: `Linked ${tilde(dir)}`,
    });
    if (r && r.code === 0) {
      setAdding(false);
      setPath('');
    }
  };

  useKeys(
    (input, key) => {
      if (adding) {
        if (key.escape) setAdding(false);
        return;
      }
      if (key.upArrow || input === 'k') setSel(Math.max(0, index - 1));
      else if (key.downArrow || input === 'j') setSel(Math.min(rows.length - 1, index + 1));
      else if (input === 'l') {
        setPath('');
        setAdding(true);
      } else if (input === 'u' && current) {
        void ctx.actions.run({
          args: unlinkArgs(current.dir),
          title: `Unlink ${tilde(current.dir)}?`,
          body: 'The agents are removed from this folder. Other files in it stay.',
          confirmLabel: 'Unlink',
          done: `Unlinked ${tilde(current.dir)}`,
        });
      }
    },
    { whileCapturing: true },
  );

  return h(
    Panel,
    { title: 'Config folders', focused: true },
    h(Text, { color: theme.dim }, 'Where the agents are linked, so Claude Code and Codex can use them.'),
    h(Text, null, ' '),
    rows.length === 0 ? h(Text, { color: theme.dim }, state.loaded ? 'No folders yet. Press l to link one.' : 'Loading...') : null,
    ...rows.map((r, i) => {
      const on = i === index;
      const bg = on ? theme.selected : undefined;
      return h(
        Box,
        { key: r.dir, flexDirection: 'column' },
        h(
          Text,
          { wrap: 'truncate-end', backgroundColor: bg },
          h(Text, { color: theme.accent }, on ? '▶ ' : '  '),
          h(Text, { bold: on }, tilde(r.dir)),
          h(Text, { color: theme.dim }, `  ${r.kind}  `),
          h(Text, { color: r.linked.length && !r.missing.length && !r.taken.length ? theme.green : theme.yellow }, homeSummary(r)),
        ),
        r.missing.length ? h(Text, { key: 'm', color: theme.yellow, wrap: 'truncate-end' }, `    missing: ${r.missing.map(short).join(', ')}`) : null,
        r.taken.length ? h(Text, { key: 't', color: theme.red, wrap: 'truncate-end' }, `    taken by something else: ${r.taken.map(short).join(', ')}`) : null,
      );
    }),
    adding
      ? h(
          Box,
          { marginTop: 1 },
          h(Text, { color: theme.dim }, 'Folder to link  '),
          h(TextInput, { value: path, onChange: setPath, placeholder: '~/.claude', onSubmit: () => void link() }),
        )
      : null,
    state.errors.homes ? h(Text, { color: theme.red }, state.errors.homes) : null,
  );
}

export const homesScreen: Screen = {
  id: 'agents.homes',
  title: 'Homes',
  component: Homes,
  hints: () => LIST_HINTS,
};
