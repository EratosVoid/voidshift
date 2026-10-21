// Checks: every doctor check with its mark and its fix. Enter on a check whose
// fix is a vsf command runs that command (after a confirm); other fixes are
// shown as text.
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { needsTerminal, commandLine } from '../actions.ts';
import { useData } from '../data.ts';
import { useEquivalent, useHints, useKeys, useScreen } from '../context.ts';
import { clock } from '../format.ts';
import { theme } from '../theme.ts';
import { Panel, Table, type Cell } from '../widgets.ts';
import type { Check } from '../../tool.ts';
import type { Screen } from '../screens.ts';

const h = React.createElement;

const ORDER = { fail: 0, warn: 1, ok: 2 } as const;

// Problems first (failed, then warnings), then the ones that are fine, each in its own order.
export function sortChecks(checks: Check[]): Check[] {
  return checks.map((c, i) => ({ c, i })).sort((a, b) => ORDER[a.c.status] - ORDER[b.c.status] || a.i - b.i).map((x) => x.c);
}

export const mark = (s: Check['status']): { text: string; colour: string } =>
  s === 'ok' ? { text: '✓', colour: theme.green } : s === 'warn' ? { text: '!', colour: theme.yellow } : { text: '✗', colour: theme.red };

// The vsf arguments in a fix like "vsf setup awake", or null when it is not a plain vsf command.
export function fixCommand(fix: string | undefined): string[] | null {
  if (!fix) return null;
  const words = fix.trim().split(/\s+/);
  if (words[0] !== 'vsf' || words.length < 2) return null;
  if (words.some((w) => /[|&;<>`$()'"\\]/.test(w))) return null;
  return words.slice(1);
}

export function checkRows(checks: Check[]): Cell[][] {
  return checks.map((c) => {
    const m = mark(c.status);
    return [{ text: m.text, colour: m.colour }, { text: c.name, bold: c.status !== 'ok' }, { text: c.detail, colour: c.status === 'ok' ? theme.dim : undefined }, { text: c.fix ?? '', colour: theme.dim }];
  });
}

function Checks(): React.ReactElement {
  const ctx = useScreen();
  const { state, refreshChecks } = useData();
  const checks = sortChecks(state.checks ?? []);
  const [sel, setSel] = useState(0);
  const at = Math.min(sel, Math.max(0, checks.length - 1));
  const check = checks[at];
  const args = fixCommand(check?.fix);

  useHints([
    { key: 'enter', label: args ? 'run the fix' : 'show the fix' },
    { key: 'r', label: 'check again' },
    { key: 'esc', label: 'back' },
  ]);
  useEquivalent(args);

  useKeys((input, key) => {
    if (key.upArrow) setSel(Math.max(0, at - 1));
    else if (key.downArrow) setSel(Math.min(checks.length - 1, at + 1));
    else if (input === 'r') {
      refreshChecks();
      ctx.toast('Checking again', 'info');
    } else if (key.return && check) {
      if (!check.fix) ctx.toast(`${check.name}: ${check.detail}. No fix needed.`, 'info');
      else if (!args) ctx.toast(`Fix for ${check.name}: ${check.fix}`, 'info');
      else if (needsTerminal(args)) {
        void (async () => {
          const ok = await ctx.actions.confirm({
            title: `Run ${commandLine(args)}?`,
            body: `Fixes ${check.name}. This opens in the terminal, and you come back here when it is done.`,
            confirmLabel: 'Run it',
            cancelLabel: 'Not now',
          });
          if (ok) {
            await ctx.actions.terminal(args);
            refreshChecks();
          }
        })();
      } else {
        void ctx.actions
          .run({ args, title: `Run ${commandLine(args)}?`, body: `Fixes ${check.name}: ${check.detail}.`, confirmLabel: 'Run it', cancelLabel: 'Not now' })
          .then((r) => r && refreshChecks());
      }
    }
  });

  if (!state.checks) {
    return h(Box, { paddingX: 1 }, h(Text, { color: state.errors.checks ? theme.red : theme.dim }, state.errors.checks ?? 'Running checks...'));
  }

  const bad = checks.filter((c) => c.status !== 'ok').length;
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Panel,
      { title: 'Checks', subtitle: `${checks.length - bad} ok${bad ? `, ${bad} need a look` : ''}${state.checksAt ? ` · checked ${clock(new Date(state.checksAt))}` : ''}`, focused: true },
      h(Table, {
        columns: [{ title: '', width: 3 }, { title: 'CHECK', width: 24 }, { title: 'WHAT WE FOUND', width: 34 }, { title: 'FIX' }],
        rows: checkRows(checks),
        selected: at,
        marker: true,
        empty: 'No checks yet.',
      }),
    ),
    check
      ? h(
          Panel,
          { title: check.name },
          h(Text, null, check.detail),
          check.fix
            ? h(Text, { color: theme.dim }, args ? `Fix: ${commandLine(args)}  (enter runs it)` : `Fix: ${check.fix}`)
            : h(Text, { color: theme.dim }, check.status === 'ok' ? 'Nothing to fix.' : 'No fix suggested.'),
        )
      : null,
  );
}

export const checksScreen: Screen = {
  id: 'checks',
  title: 'Checks',
  component: () => h(Checks),
  hints: () => [{ key: 'enter', label: 'fix' }, { key: 'r', label: 'check again' }, { key: 'esc', label: 'back' }],
};
