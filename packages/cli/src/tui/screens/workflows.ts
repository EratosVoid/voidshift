// Agents, Workflows: the workflows in match order. Every change is a real
// `vsf agents workflow ...` command run as a child process.
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useData, type StepsCatalog, type WorkflowItem } from '../data.ts';
import { useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { theme } from '../theme.ts';
import { Panel, Table, TextInput, type Column } from '../widgets.ts';
import type { Screen } from '../screens.ts';

const h = React.createElement;

// ---- pure helpers (shared with the workflow form) --------------------------

const FALLBACK_LABELS: Record<string, string> = {
  'vs-plan': 'Plan',
  'vs-plan-review': 'Plan review',
  'vs-publish': 'Publish',
  'vs-dev': 'Dev',
  'vs-qa': 'QA',
};

export function stepLabel(catalog: StepsCatalog | null, id: string): string {
  const found = catalog?.steps.find((s) => s.id === id);
  if (found) return found.label;
  if (FALLBACK_LABELS[id]) return FALLBACK_LABELS[id]!;
  const t = id.replace(/^vs-/, '').replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// The short name the commands take: "dev", "plan-review".
export function stepName(catalog: StepsCatalog | null, id: string): string {
  return catalog?.steps.find((s) => s.id === id)?.name ?? id.replace(/^vs-/, '');
}

export interface TriggerLike {
  team: string;
  label: string;
}

export const triggerText = (t: TriggerLike): string => `${t.team} + ${t.label}`;
export const triggersText = (triggers: TriggerLike[]): string => triggers.map(triggerText).join(', ');
export const sameTriggerLike = (a: TriggerLike, b: TriggerLike): boolean => a.team === b.team && a.label === b.label;

export const stepsText = (catalog: StepsCatalog | null, steps: string[]): string => steps.map((s) => stepLabel(catalog, s)).join(' → ');

export interface MatchWarning {
  loser: string;
  winner: string;
  triggers: TriggerLike[];
}

// Two workflows that start on the same TEAM:LABEL: only the first in order
// starts the card. One entry per (loser, winner) pair.
export function matchWarnings(workflows: { name: string; triggers: TriggerLike[] }[]): MatchWarning[] {
  const out: MatchWarning[] = [];
  workflows.forEach((w, j) => {
    const byWinner = new Map<string, TriggerLike[]>();
    for (const t of w.triggers) {
      const winner = workflows.slice(0, j).find((o) => o.triggers.some((x) => sameTriggerLike(x, t)));
      if (!winner) continue;
      byWinner.set(winner.name, [...(byWinner.get(winner.name) ?? []), t]);
    }
    for (const [winner, triggers] of byWinner) out.push({ loser: w.name, winner, triggers });
  });
  return out;
}

export const warningText = (w: MatchWarning): string =>
  `${w.loser} also starts on ${w.triggers.map(triggerText).join(', ')}, so ${w.winner} wins.`;

// The move command for J (dir 1, down) or K (dir -1, up); null at the ends.
export function moveArgs(workflows: { name: string }[], index: number, dir: 1 | -1): string[] | null {
  const me = workflows[index];
  const other = workflows[index + dir];
  if (!me || !other) return null;
  return ['agents', 'workflow', 'move', me.name, dir === 1 ? '--after' : '--before', other.name];
}

// Column widths that fit the longest cell (plus a gap), within the terminal.
export function workflowColumns(columns: number, workflows: WorkflowItem[] = [], catalog: StepsCatalog | null = null): Column[] {
  const fit = (min: number, texts: string[], max: number) => Math.min(max, Math.max(min, ...texts.map((t) => t.length + 2)));
  const budget = Math.max(60, columns - 12);
  const name = fit(12, workflows.map((w) => w.name), 28);
  const trig = fit(14, workflows.map((w) => triggersText(w.triggers)), 28);
  const proj = fit(10, workflows.map((w) => w.project), 20);
  const steps = Math.max(12, Math.min(fit(12, workflows.map((w) => stepsText(catalog, w.steps)), 48), budget - 4 - 6 - name - trig - proj));
  return [{ title: '#', width: 4 }, { title: 'Name', width: name }, { title: 'Starts when', width: trig }, { title: 'Steps', width: steps }, { title: 'Project', width: proj }, { title: 'Rounds' }];
}

export function workflowRows(workflows: WorkflowItem[], catalog: StepsCatalog | null) {
  return workflows.map((w, i) => [
    { text: String(i + 1), colour: theme.dim },
    { text: w.name, bold: true },
    triggersText(w.triggers),
    stepsText(catalog, w.steps),
    { text: w.project, colour: theme.accent },
    String(w.maxRounds),
  ]);
}

// ---- screen ----------------------------------------------------------------

const LIST_HINTS: Hint[] = [
  { key: 'n', label: 'new' },
  { key: 'e', label: 'edit' },
  { key: 'R', label: 'rename' },
  { key: 'J/K', label: 'move down/up' },
  { key: 'd', label: 'delete' },
  { key: 'esc', label: 'back' },
];

function WorkflowsList(): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const list = state.workflows;
  const [selName, setSelName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const found = list.findIndex((w) => w.name === selName);
  const index = found >= 0 ? found : Math.min(0, list.length - 1);
  const selected = list[index];
  const warnings = matchWarnings(list);

  useHints(renaming !== null ? [{ key: 'enter', label: 'rename' }, { key: 'esc', label: 'cancel' }] : LIST_HINTS);
  useEquivalent(renaming !== null && draft.trim() && draft.trim() !== renaming ? ['agents', 'workflow', 'rename', renaming, draft.trim()] : null);

  const rename = async () => {
    const next = draft.trim();
    if (renaming === null) return;
    if (!next || next === renaming) {
      setRenaming(null);
      return;
    }
    if (list.some((w) => w.name === next)) {
      ctx.toast(`A workflow named ${next} already exists.`, 'error');
      return;
    }
    const r = await ctx.actions.run({ args: ['agents', 'workflow', 'rename', renaming, next], title: 'Rename workflow', noConfirm: true, done: `Renamed to ${next}` });
    if (r && r.code === 0) setSelName(next);
    if (r) setRenaming(null);
  };

  useKeys(
    (input, key) => {
      if (renaming !== null) {
        if (key.escape) setRenaming(null);
        return;
      }
      if (key.upArrow || input === 'k') setSelName(list[Math.max(0, index - 1)]?.name ?? null);
      else if (key.downArrow || input === 'j') setSelName(list[Math.min(list.length - 1, index + 1)]?.name ?? null);
      else if (input === 'n') {
        if (!state.projects.length) ctx.toast('Add a project first, on the Projects tab.', 'info');
        else ctx.nav.push('agents.workflow.form', {});
      } else if ((input === 'e' || key.return) && selected) ctx.nav.push('agents.workflow.form', { name: selected.name });
      else if (input === 'R' && selected) {
        setDraft(selected.name);
        setRenaming(selected.name);
      } else if ((input === 'J' || input === 'K') && selected) {
        const args = moveArgs(list, index, input === 'J' ? 1 : -1);
        if (!args) ctx.toast(input === 'J' ? 'Already last.' : 'Already first.', 'info');
        else void ctx.actions.run({ args, title: 'Move workflow', noConfirm: true, done: `Moved ${selected.name}` });
      } else if (input === 'd' && selected) {
        void ctx.actions.run({
          args: ['agents', 'workflow', 'rm', selected.name, '--yes'],
          title: `Delete workflow ${selected.name}?`,
          body: 'Cards will no longer start it. Runs already recorded stay.',
          confirmLabel: 'Delete',
          done: `Deleted ${selected.name}`,
        });
      }
    },
    { whileCapturing: true },
  );

  return h(
    Panel,
    { title: 'Workflows, in match order', focused: true },
    h(Text, { color: theme.dim }, 'The first workflow that matches a card wins.'),
    h(Text, null, ' '),
    h(Table, {
      columns: workflowColumns(ctx.columns, list, state.steps),
      rows: workflowRows(list, state.steps),
      selected: index,
      empty: state.loaded ? 'No workflows yet. Press n to make one.' : 'Loading...',
    }),
    warnings.length ? h(Text, null, ' ') : null,
    ...warnings.map((w, i) =>
      h(Text, { key: i, color: theme.yellow, wrap: 'truncate-end' }, `! ${warningText(w)}${i === warnings.length - 1 ? ' J/K reorders.' : ''}`),
    ),
    renaming !== null
      ? h(
          Box,
          { marginTop: 1 },
          h(Text, { color: theme.dim }, `Rename ${renaming} to  `),
          h(TextInput, { value: draft, onChange: setDraft, onSubmit: () => void rename() }),
        )
      : null,
    state.errors.workflows ? h(Text, { color: theme.red }, state.errors.workflows) : null,
  );
}

export const workflowsScreen: Screen = {
  id: 'agents.workflows',
  title: 'Workflows',
  component: WorkflowsList,
  hints: () => LIST_HINTS,
};
