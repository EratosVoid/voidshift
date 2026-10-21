// Agents, Projects: the repos the workflows run in.
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useData, type ProjectItem } from '../data.ts';
import { useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { tilde } from '../format.ts';
import { theme } from '../theme.ts';
import { Panel, Table, TextInput, type Column } from '../widgets.ts';
import type { Screen } from '../screens.ts';

const h = React.createElement;

export const baseText = (p: Pick<ProjectItem, 'base'>): string => p.base ?? 'default branch';

export const usedByText = (p: Pick<ProjectItem, 'usedBy'>): string => (p.usedBy?.length ? `used by ${p.usedBy.join(', ')}` : 'not used');

export function projectRows(projects: ProjectItem[]) {
  return projects.map((p) => [{ text: p.name, bold: true }, tilde(p.path), `PRs into ${baseText(p)}`, { text: usedByText(p), colour: theme.dim }]);
}

export function projectColumns(columns: number, projects: ProjectItem[] = []): Column[] {
  const fit = (min: number, texts: string[], max: number) => Math.min(max, Math.max(min, ...texts.map((t) => t.length + 2)));
  const name = fit(12, projects.map((p) => p.name), 26);
  const base = fit(18, projects.map((p) => `PRs into ${baseText(p)}`), 30);
  const path = Math.min(fit(16, projects.map((p) => tilde(p.path)), 48), Math.max(16, columns - 12 - 2 - name - base - 24));
  return [{ title: 'Name', width: name }, { title: 'Path', width: path }, { title: 'Base', width: base }, { title: 'Used by' }];
}

// Why a project cannot be deleted, or null when it can (the command refuses the same way).
export function deleteBlock(p: ProjectItem): string | null {
  return p.usedBy?.length ? `${p.name} is used by ${p.usedBy.join(', ')}. Change or delete those workflows first.` : null;
}

const LIST_HINTS: Hint[] = [
  { key: 'n', label: 'new' },
  { key: 'e', label: 'edit' },
  { key: 'R', label: 'rename' },
  { key: 'd', label: 'delete' },
  { key: 'esc', label: 'back' },
];

function Projects(): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const list = state.projects;
  const [selName, setSelName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const found = list.findIndex((p) => p.name === selName);
  const index = found >= 0 ? found : Math.min(0, list.length - 1);
  const selected = list[index];

  useHints(renaming !== null ? [{ key: 'enter', label: 'rename' }, { key: 'esc', label: 'cancel' }] : LIST_HINTS);
  useEquivalent(renaming !== null && draft.trim() && draft.trim() !== renaming ? ['agents', 'project', 'rename', renaming, draft.trim()] : null);

  const rename = async () => {
    const next = draft.trim();
    if (renaming === null) return;
    if (!next || next === renaming) {
      setRenaming(null);
      return;
    }
    if (list.some((p) => p.name === next)) {
      ctx.toast(`A project named ${next} already exists.`, 'error');
      return;
    }
    const r = await ctx.actions.run({ args: ['agents', 'project', 'rename', renaming, next], title: 'Rename project', noConfirm: true, done: `Renamed to ${next}` });
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
      else if (input === 'n') ctx.nav.push('agents.project.form', {});
      else if ((input === 'e' || key.return) && selected) ctx.nav.push('agents.project.form', { name: selected.name });
      else if (input === 'R' && selected) {
        setDraft(selected.name);
        setRenaming(selected.name);
      } else if (input === 'd' && selected) {
        const block = deleteBlock(selected);
        if (block) ctx.toast(block, 'error');
        else
          void ctx.actions.run({
            args: ['agents', 'project', 'rm', selected.name, '--yes'],
            title: `Delete project ${selected.name}?`,
            body: 'Only the entry is removed. The repo on disk is not touched.',
            confirmLabel: 'Delete',
            done: `Deleted ${selected.name}`,
          });
      }
    },
    { whileCapturing: true },
  );

  return h(
    Panel,
    { title: 'Projects', focused: true },
    h(Text, { color: theme.dim }, 'Repos on this Mac where agents do the work.'),
    h(Text, null, ' '),
    h(Table, {
      columns: projectColumns(ctx.columns, list),
      rows: projectRows(list),
      selected: index,
      empty: state.loaded ? 'No projects yet. Press n to add one.' : 'Loading...',
    }),
    renaming !== null
      ? h(
          Box,
          { marginTop: 1 },
          h(Text, { color: theme.dim }, `Rename ${renaming} to  `),
          h(TextInput, { value: draft, onChange: setDraft, onSubmit: () => void rename() }),
        )
      : null,
    state.errors.projects ? h(Text, { color: theme.red }, state.errors.projects) : null,
  );
}

export const projectsScreen: Screen = {
  id: 'agents.projects',
  title: 'Projects',
  component: Projects,
  hints: () => LIST_HINTS,
};
