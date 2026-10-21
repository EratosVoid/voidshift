// The project form: Name, Path, Base branch. Saves with
// `vsf agents project add|edit`, run as a child process.
import React, { useState } from 'react';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useData } from '../data.ts';
import { useBackGuard, useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { theme } from '../theme.ts';
import { Panel, TextInput } from '../widgets.ts';
import type { Screen } from '../screens.ts';

const h = React.createElement;

export type ProjectField = 'name' | 'path' | 'base';

export interface ProjectDraft {
  name: string;
  path: string;
  base: string;
}

export function expandPath(p: string, home: string = homedir()): string {
  const t = p.trim();
  if (t === '~') return home;
  if (t.startsWith('~/')) return join(home, t.slice(2));
  return t ? resolve(t) : t;
}

// ok: a git repository. missing: nothing typed yet. not-repo: anything else.
export function repoState(path: string, exists: (p: string) => boolean = existsSync): 'ok' | 'empty' | 'not-repo' {
  if (!path.trim()) return 'empty';
  return exists(join(expandPath(path), '.git')) ? 'ok' : 'not-repo';
}

export function projectProblems(d: ProjectDraft, isNew: boolean, existing: string[], exists?: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (isNew) {
    if (!d.name.trim()) out.push('Give the project a name.');
    else if (existing.includes(d.name.trim())) out.push(`A project named ${d.name.trim()} already exists.`);
  }
  const r = repoState(d.path, exists);
  if (r === 'empty') out.push('Give the path to a git repository.');
  else if (r === 'not-repo') out.push('That path is not a git repository.');
  return out;
}

export function projectSaveArgs(d: ProjectDraft, isNew: boolean): string[] {
  const name = d.name.trim();
  const path = d.path.trim();
  const base = d.base.trim();
  if (isNew) return ['agents', 'project', 'add', name, '--path', path, ...(base ? ['--base', base] : [])];
  // An empty --base on edit clears it, so PRs go to the repo's default branch.
  return ['agents', 'project', 'edit', name, '--path', path, '--base', base];
}

export const fieldsFor = (isNew: boolean): ProjectField[] => (isNew ? ['name', 'path', 'base'] : ['path', 'base']);

export function moveFocus(fields: ProjectField[], current: ProjectField, delta: number): ProjectField {
  const i = Math.max(0, fields.indexOf(current));
  return fields[(i + delta + fields.length) % fields.length]!;
}

const KEY_HINTS: Hint[] = [
  { key: 'tab', label: 'next field' },
  { key: 'ctrl+s', label: 'save' },
  { key: 'esc', label: 'discard' },
];

function Row(props: { label: string; focused: boolean; children?: React.ReactNode; note?: React.ReactNode }): React.ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      null,
      h(Box, { width: 14, flexShrink: 0 }, h(Text, { bold: props.focused, color: props.focused ? theme.accent : theme.text }, props.label)),
      h(Box, { flexGrow: 1 }, props.children),
    ),
    props.note ? h(Box, { paddingLeft: 14 }, props.note) : null,
  );
}

function ProjectForm(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const origName = typeof props.params.name === 'string' ? props.params.name : null;
  const isNew = origName === null;
  const [initial] = useState<ProjectDraft>(() => {
    const p = origName ? state.projects.find((x) => x.name === origName) : undefined;
    return { name: origName ?? '', path: p?.path ?? '', base: p?.base ?? '' };
  });
  const [draft, setDraft] = useState<ProjectDraft>(initial);
  const fields = fieldsFor(isNew);
  const [focus, setFocus] = useState<ProjectField>(fields[0]!);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const problems = projectProblems(draft, isNew, state.projects.map((p) => p.name));
  const args = projectSaveArgs(draft, isNew);
  const set = (key: ProjectField) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const repo = repoState(draft.path);

  useHints(KEY_HINTS);
  useEquivalent(draft.name.trim() ? args : null);
  useBackGuard(() => true);

  const save = async () => {
    if (busy) return;
    if (problems.length) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await ctx.actions.run({ args, title: 'Save project', noConfirm: true, done: `Saved ${draft.name.trim()}` });
    setBusy(false);
    if (r && r.code === 0) ctx.nav.pop();
    else if (r) setError(r.output || `vsf exited with code ${r.code}`);
  };

  const discard = async () => {
    if (dirty) {
      const ok = await ctx.actions.confirm({ title: 'Discard changes?', body: 'What you typed here will be lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
      if (!ok) return;
    }
    ctx.nav.pop();
  };

  useKeys(
    (input, key) => {
      if (key.escape) void discard();
      else if (key.ctrl && input === 's') void save();
      else if (key.tab) setFocus((f) => moveFocus(fields, f, key.shift ? -1 : 1));
      else if (key.downArrow) setFocus((f) => moveFocus(fields, f, 1));
      else if (key.upArrow) setFocus((f) => moveFocus(fields, f, -1));
    },
    { whileCapturing: true },
  );

  const pathNote =
    repo === 'ok'
      ? h(Text, { color: theme.green }, 'git repository')
      : repo === 'not-repo'
        ? h(Text, { color: theme.red }, 'Not a git repository (no .git in that folder)')
        : h(Text, { color: theme.dim }, 'Where the repo lives, like ~/me/tether/tether-relay');

  return h(
    Panel,
    { title: isNew ? 'New project' : 'Edit project', focused: true },
    isNew
      ? h(Row, { label: 'Name', focused: focus === 'name' }, h(TextInput, { value: draft.name, onChange: set('name'), focus: focus === 'name', placeholder: 'tether-relay' }))
      : h(Row, { label: 'Name', focused: false }, h(Text, null, draft.name), h(Text, { color: theme.dim }, '   R on the list renames it')),
    h(Text, null, ' '),
    h(Row, { label: 'Path', focused: focus === 'path', note: pathNote }, h(TextInput, { value: draft.path, onChange: set('path'), focus: focus === 'path', placeholder: '~/me/repo' })),
    h(Text, null, ' '),
    h(
      Row,
      { label: 'Base branch', focused: focus === 'base', note: h(Text, { color: theme.dim }, 'Pull requests go into this branch. Empty means the repo default.') },
      h(TextInput, { value: draft.base, onChange: set('base'), focus: focus === 'base', placeholder: 'default branch' }),
    ),
    attempted && problems.length ? h(Box, { flexDirection: 'column', marginTop: 1 }, ...problems.map((p, i) => h(Text, { key: i, color: theme.red }, `! ${p}`))) : null,
    error ? h(Box, { marginTop: 1 }, h(Text, { color: theme.red }, error)) : null,
    busy ? h(Text, { color: theme.dim }, 'Saving...') : null,
  );
}

export const projectFormScreen: Screen = {
  id: 'agents.project.form',
  title: (p) => ['Projects', typeof p.name === 'string' ? `Edit ${p.name}` : 'New project'],
  component: (props) => h(ProjectForm, { params: props.params }),
  hints: () => KEY_HINTS,
};
