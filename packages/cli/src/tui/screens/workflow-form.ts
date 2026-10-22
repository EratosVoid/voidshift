// The workflow form: Name, Starts when (triggers), Steps, Project, Rounds.
// Saves with `vsf agents workflow add|edit` (and `rename` first when the name
// changed), each run as a child process.
import React, { useReducer, useState } from 'react';
import { Box, Text } from 'ink';
import { useData, type StepsCatalog, type WorkflowItem } from '../data.ts';
import { useBackGuard, useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { theme } from '../theme.ts';
import { Panel, Select, TextInput, type Option } from '../widgets.ts';
import { tilde } from '../format.ts';
import type { Screen } from '../screens.ts';
import { matchWarnings, stepLabel, stepName, triggerText, warningText, sameTriggerLike, type TriggerLike } from './workflows.ts';

const h = React.createElement;

// ---- pure form state ---------------------------------------------------------

export interface FormState {
  name: string;
  triggers: TriggerLike[];
  // Step ids, like "vs-dev".
  steps: string[];
  project: string;
  rounds: number;
}

export type FormAction =
  | { type: 'name'; value: string }
  | { type: 'addTrigger'; trigger: TriggerLike }
  | { type: 'removeTrigger'; index: number }
  | { type: 'addStep'; id: string }
  | { type: 'removeStep'; index: number }
  | { type: 'moveStep'; index: number; dir: 1 | -1 }
  | { type: 'project'; value: string }
  | { type: 'rounds'; value: number };

export function formReducer(s: FormState, a: FormAction): FormState {
  switch (a.type) {
    case 'name':
      return { ...s, name: a.value };
    case 'addTrigger':
      return s.triggers.some((t) => sameTriggerLike(t, a.trigger)) ? s : { ...s, triggers: [...s.triggers, a.trigger] };
    case 'removeTrigger':
      return { ...s, triggers: s.triggers.filter((_, i) => i !== a.index) };
    case 'addStep':
      return s.steps.includes(a.id) ? s : { ...s, steps: [...s.steps, a.id] };
    case 'removeStep':
      return { ...s, steps: s.steps.filter((_, i) => i !== a.index) };
    case 'moveStep': {
      const to = a.index + a.dir;
      if (to < 0 || to >= s.steps.length || a.index < 0 || a.index >= s.steps.length) return s;
      const steps = [...s.steps];
      [steps[a.index], steps[to]] = [steps[to]!, steps[a.index]!];
      return { ...s, steps };
    }
    case 'project':
      return { ...s, project: a.value };
    case 'rounds':
      return { ...s, rounds: Math.max(1, Math.min(9, Math.round(a.value))) };
  }
}

export function initialForm(w: WorkflowItem | undefined, name: string, projects: string[]): FormState {
  if (w) return { name, triggers: w.triggers.map((t) => ({ team: t.team, label: t.label })), steps: [...w.steps], project: w.project, rounds: w.maxRounds };
  return { name: '', triggers: [], steps: [], project: projects.length === 1 ? projects[0]! : '', rounds: 3 };
}

const FALLBACK_PRODUCERS = ['vs-plan', 'vs-dev'];

// A producer (Plan or Dev) is what a failed check sends the work back to.
export function hasProducer(steps: string[], catalog: StepsCatalog | null): boolean {
  return steps.some((id) => {
    const s = catalog?.steps.find((x) => x.id === id);
    return s ? s.output === 'plan' || s.output === 'commits' : FALLBACK_PRODUCERS.includes(id);
  });
}

export const effectiveRounds = (s: FormState, catalog: StepsCatalog | null): number => (hasProducer(s.steps, catalog) ? s.rounds : 1);

// Steps that can still be added, in catalog order.
export function availableSteps(s: FormState, catalog: StepsCatalog | null): { id: string; label: string; hint: string }[] {
  const all = catalog?.steps.map((x) => ({ id: x.id, label: x.label, hint: x.hint })) ?? [
    { id: 'vs-plan', label: 'Plan', hint: '' },
    { id: 'vs-plan-review', label: 'Plan review', hint: '' },
    { id: 'vs-publish', label: 'Publish', hint: '' },
    { id: 'vs-dev', label: 'Dev', hint: '' },
    { id: 'vs-qa', label: 'QA', hint: '' },
  ];
  return all.filter((x) => !s.steps.includes(x.id));
}

// "when ENG + vs-plan: Dev → QA in tether-relay, 3 rounds"
export function summaryLine(s: FormState, catalog: StepsCatalog | null): string {
  const when = s.triggers.length ? s.triggers.map(triggerText).join(', ') : '(no trigger yet)';
  const steps = s.steps.length ? s.steps.map((id) => stepLabel(catalog, id)).join(' → ') : '(no steps yet)';
  const project = s.project || '(no project yet)';
  const n = effectiveRounds(s, catalog);
  return `when ${when}: ${steps} in ${project}, ${n} ${n === 1 ? 'round' : 'rounds'}`;
}

export function formProblems(s: FormState, isNew: boolean, origName: string | null, existingNames: string[], projectNames: string[]): string[] {
  const out: string[] = [];
  const name = s.name.trim();
  if (!name) out.push('Give the workflow a name.');
  else if (/\s/.test(name)) out.push('The name cannot have spaces.');
  else if ((isNew || name !== origName) && existingNames.includes(name)) out.push(`A workflow named ${name} already exists.`);
  if (!s.triggers.length) out.push('Add at least one trigger (press a on Starts when).');
  if (!s.steps.length) out.push('Add at least one step (press + on Steps).');
  if (!projectNames.length) out.push('There are no projects yet. Add one on the Projects tab first.');
  else if (!s.project || !projectNames.includes(s.project)) out.push('Choose a project.');
  return out;
}

// The command a save runs (after `rename`, when the name changed).
export function saveArgs(s: FormState, isNew: boolean, catalog: StepsCatalog | null): string[] {
  return [
    'agents',
    'workflow',
    isNew ? 'add' : 'edit',
    s.name.trim(),
    ...s.triggers.flatMap((t) => ['--trigger', `${t.team}:${t.label}`]),
    '--steps',
    s.steps.map((id) => stepName(catalog, id)).join(','),
    '--project',
    s.project,
    '--rounds',
    String(effectiveRounds(s, catalog)),
  ];
}

export const renameArgs = (from: string, to: string): string[] => ['agents', 'workflow', 'rename', from, to];

// A trigger from the two text fields, or a complaint.
export function makeTrigger(team: string, label: string): { trigger: TriggerLike } | { error: string } {
  const t = team.trim().toUpperCase();
  const l = label.trim();
  if (!t) return { error: 'Give the Linear team, like ENG.' };
  if (t.includes(':') || /\s/.test(t)) return { error: 'The team is a short key like ENG.' };
  if (!l) return { error: 'Give the label, like vs-plan.' };
  return { trigger: { team: t, label: l } };
}

// Warnings for triggers this workflow shares with another. In place when
// editing, last in order when new.
export function sharedTriggerWarnings(workflows: WorkflowItem[], s: FormState, origName: string | null): string[] {
  const me = { name: s.name.trim() || 'this workflow', triggers: s.triggers };
  const others = workflows.map((w) => ({ name: w.name, triggers: w.triggers }));
  const at = origName === null ? -1 : others.findIndex((w) => w.name === origName);
  const merged = at >= 0 ? others.map((w, i) => (i === at ? me : w)) : [...others, me];
  return matchWarnings(merged)
    .filter((w) => w.loser === me.name || w.winner === me.name)
    .map(warningText);
}

export type Section = 'name' | 'triggers' | 'steps' | 'project' | 'rounds';

export function sectionsFor(s: FormState, catalog: StepsCatalog | null): Section[] {
  return hasProducer(s.steps, catalog) ? ['name', 'triggers', 'steps', 'project', 'rounds'] : ['name', 'triggers', 'steps', 'project'];
}

const KEY_HINTS: Hint[] = [
  { key: 'tab', label: 'next field' },
  { key: 'ctrl+s', label: 'save' },
  { key: 'esc', label: 'discard' },
];

// ---- component ----------------------------------------------------------------

function Label(props: { text: string; focused: boolean }): React.ReactElement {
  return h(Box, { width: 13, flexShrink: 0 }, h(Text, { bold: props.focused, color: props.focused ? theme.accent : theme.text }, props.text));
}

function WorkflowForm(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const catalog = state.steps;
  const origName = typeof props.params.name === 'string' ? props.params.name : null;
  const isNew = origName === null;
  const projectNames = state.projects.map((p) => p.name);
  const [initial] = useState<FormState>(() =>
    initialForm(origName ? state.workflows.find((w) => w.name === origName) : undefined, origName ?? '', projectNames),
  );
  const [form, dispatch] = useReducer(formReducer, initial);
  const [focus, setFocus] = useState<Section>('name');
  const [tCursor, setTCursor] = useState(0);
  const [sCursor, setSCursor] = useState(0);
  const [adding, setAdding] = useState<null | 'team' | 'label'>(null);
  const [newTeam, setNewTeam] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sections = sectionsFor(form, catalog);
  const where: Section = sections.includes(focus) ? focus : 'steps';
  const producer = hasProducer(form.steps, catalog);
  const avail = availableSteps(form, catalog);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const existing = state.workflows.map((w) => w.name);
  const problems = formProblems(form, isNew, origName, existing, projectNames);
  const nameTaken = form.name.trim() !== '' && (isNew || form.name.trim() !== origName) && existing.includes(form.name.trim());
  const warnings = sharedTriggerWarnings(state.workflows, form, origName);
  const typing = (where === 'name' && adding === null && picking === null) || adding !== null;

  useHints(adding !== null ? [{ key: 'enter', label: 'add trigger' }, { key: 'tab', label: 'team / label' }, { key: 'esc', label: 'cancel' }] : picking !== null ? [{ key: '↑↓', label: 'choose' }, { key: 'enter', label: 'add step' }, { key: 'esc', label: 'cancel' }] : KEY_HINTS);
  useEquivalent(form.name.trim() ? saveArgs(form, isNew, catalog) : null);
  useBackGuard(() => true);

  const move = (delta: number) => setFocus(sections[(sections.indexOf(where) + delta + sections.length) % sections.length]!);

  const save = async () => {
    if (busy) return;
    if (problems.length) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setError(null);
    const name = form.name.trim();
    if (!isNew && origName && name !== origName) {
      const r = await ctx.actions.run({ args: renameArgs(origName, name), title: 'Rename workflow', noConfirm: true });
      if (!r || r.code !== 0) {
        setBusy(false);
        if (r) setError(r.output || 'Could not rename the workflow.');
        return;
      }
    }
    const r = await ctx.actions.run({ args: saveArgs(form, isNew, catalog), title: 'Save workflow', noConfirm: true, done: `Saved ${name}` });
    setBusy(false);
    if (r && r.code === 0) ctx.nav.pop();
    else if (r) setError(r.output || `vsf exited with code ${r.code}`);
  };

  const discard = async () => {
    if (dirty) {
      const ok = await ctx.actions.confirm({ title: 'Discard changes?', body: 'What you changed here will be lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
      if (!ok) return;
    }
    ctx.nav.pop();
  };

  const commitTrigger = () => {
    const r = makeTrigger(newTeam, newLabel);
    if ('error' in r) {
      setAddError(r.error);
      setAdding(newTeam.trim() ? 'label' : 'team');
      return;
    }
    dispatch({ type: 'addTrigger', trigger: r.trigger });
    setTCursor(form.triggers.length);
    setAdding(null);
    setAddError(null);
    setNewTeam('');
    setNewLabel('');
  };

  useKeys(
    (input, key) => {
      // A Select that is open owns the keys.
      if (ctx.capturing && !typing) return;
      if (key.escape) {
        if (adding !== null) {
          setAdding(null);
          setAddError(null);
        } else if (picking !== null) setPicking(null);
        else void discard();
        return;
      }
      if (key.ctrl && input === 's') {
        void save();
        return;
      }
      if (adding !== null) {
        if (key.tab) setAdding(adding === 'team' ? 'label' : 'team');
        return;
      }
      if (picking !== null) {
        if (key.upArrow) setPicking((i) => Math.max(0, (i ?? 0) - 1));
        else if (key.downArrow) setPicking((i) => Math.min(avail.length - 1, (i ?? 0) + 1));
        else if (key.return) {
          const pick = avail[picking];
          if (pick) {
            dispatch({ type: 'addStep', id: pick.id });
            setSCursor(form.steps.length);
          }
          setPicking(null);
        }
        return;
      }
      if (key.tab) {
        move(key.shift ? -1 : 1);
        return;
      }
      if (where === 'name') {
        if (key.downArrow) move(1);
        else if (key.upArrow) move(-1);
        return;
      }
      if (where === 'triggers') {
        if (input === 'a') {
          setAdding('team');
          setNewTeam('');
          setNewLabel('');
          setAddError(null);
        } else if (input === 'x' && form.triggers.length) {
          dispatch({ type: 'removeTrigger', index: tCursor });
          setTCursor(Math.max(0, Math.min(tCursor, form.triggers.length - 2)));
        } else if (key.upArrow) (tCursor > 0 ? setTCursor(tCursor - 1) : move(-1));
        else if (key.downArrow) (tCursor < form.triggers.length - 1 ? setTCursor(tCursor + 1) : move(1));
        return;
      }
      if (where === 'steps') {
        if ((input === '+' || input === 'a') && avail.length) setPicking(0);
        else if (input === 'x' && form.steps.length) {
          dispatch({ type: 'removeStep', index: sCursor });
          setSCursor(Math.max(0, Math.min(sCursor, form.steps.length - 2)));
        } else if (input === 'J' || input === 'K') {
          const dir = input === 'J' ? 1 : -1;
          if (sCursor + dir >= 0 && sCursor + dir < form.steps.length) {
            dispatch({ type: 'moveStep', index: sCursor, dir });
            setSCursor(sCursor + dir);
          }
        } else if (key.leftArrow) setSCursor(Math.max(0, sCursor - 1));
        else if (key.rightArrow) setSCursor(Math.min(form.steps.length - 1, sCursor + 1));
        else if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        return;
      }
      if (where === 'project') {
        if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        return;
      }
      if (where === 'rounds') {
        if (/^[1-9]$/.test(input)) dispatch({ type: 'rounds', value: Number(input) });
        else if (key.leftArrow || input === '-') dispatch({ type: 'rounds', value: form.rounds - 1 });
        else if (key.rightArrow || input === '+') dispatch({ type: 'rounds', value: form.rounds + 1 });
        else if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
      }
    },
    { whileCapturing: true },
  );

  const projectOptions: Option[] = state.projects.map((p) => ({ value: p.name, label: p.name, hint: `${tilde(p.path)}, PRs into ${p.base ?? 'the default branch'}` }));

  // Steps line: "1 Dev  →  2 QA", the focused one highlighted.
  const stepNodes: React.ReactNode[] = [];
  form.steps.forEach((id, i) => {
    const on = where === 'steps' && i === sCursor;
    if (i > 0) stepNodes.push(h(Text, { key: `a${i}`, color: theme.dim }, '  →  '));
    stepNodes.push(
      h(Text, { key: id, backgroundColor: on ? theme.selected : undefined, bold: on, color: on ? theme.bold : undefined }, `${i + 1} ${stepLabel(catalog, id)}`),
    );
  });

  return h(
    Panel,
    { title: isNew ? 'New workflow' : 'Edit workflow', focused: true },
    // Name
    h(
      Box,
      null,
      h(Label, { text: 'Name', focused: where === 'name' }),
      where === 'name' && adding === null && picking === null ? null : h(Text, null, ' '),
      h(TextInput, { value: form.name, onChange: (v: string) => dispatch({ type: 'name', value: v }), focus: where === 'name' && adding === null && picking === null, placeholder: 'tether-relay-build' }),
      nameTaken ? h(Text, { color: theme.red }, '   already taken') : null,
    ),
    h(Text, null, ' '),
    // Triggers
    h(
      Box,
      null,
      h(Label, { text: 'Starts when', focused: where === 'triggers' }),
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        form.triggers.length === 0 ? h(Text, { color: theme.dim }, ' no trigger yet') : null,
        ...form.triggers.map((t, i) => {
          const on = where === 'triggers' && i === tCursor && adding === null;
          return h(Text, { key: `${t.team}:${t.label}`, backgroundColor: on ? theme.selected : undefined, bold: on, color: on ? theme.bold : undefined }, ` ${triggerText(t)} `);
        }),
        adding !== null
          ? h(
              Box,
              { flexDirection: 'column' },
              h(
                Box,
                null,
                h(Text, { color: theme.dim }, ' team '),
                h(TextInput, { value: newTeam, onChange: setNewTeam, focus: adding === 'team', placeholder: 'ENG', onSubmit: () => setAdding('label') }),
                h(Text, { color: theme.dim }, '  label '),
                h(TextInput, { value: newLabel, onChange: setNewLabel, focus: adding === 'label', placeholder: 'vs-plan', onSubmit: commitTrigger }),
              ),
              addError ? h(Text, { color: theme.red }, `  ${addError}`) : null,
            )
          : null,
      ),
      h(Box, { flexShrink: 0, marginLeft: 2 }, h(Text, { color: theme.dim }, where === 'triggers' ? 'a add trigger · x remove' : '')),
    ),
    h(Text, null, ' '),
    // Steps
    h(
      Box,
      null,
      h(Label, { text: 'Steps', focused: where === 'steps' }),
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        form.steps.length === 0 ? h(Text, { color: theme.dim }, ' no steps yet') : h(Text, { wrap: 'truncate-end' }, ' ', ...stepNodes),
        picking !== null
          ? h(
              Box,
              { flexDirection: 'column' },
              ...avail.map((s, i) =>
                h(
                  Text,
                  { key: s.id, wrap: 'truncate-end', backgroundColor: i === picking ? theme.selected : undefined, color: i === picking ? theme.bold : theme.text },
                  ` ${i === picking ? '▶ ' : '  '}${s.label}`,
                  s.hint ? h(Text, { color: theme.dim, wrap: 'truncate-end' }, `  ${s.hint}`) : null,
                ),
              ),
            )
          : avail.length
            ? h(Text, { color: theme.dim, wrap: 'truncate-end' }, ` available: ${avail.map((s) => s.label).join(', ')}`)
            : null,
      ),
      h(Box, { flexShrink: 0, marginLeft: 2 }, h(Text, { color: theme.dim }, where === 'steps' && picking === null ? '+ add · J/K reorder · x remove' : '')),
    ),
    h(Text, null, ' '),
    // Project
    h(
      Box,
      null,
      h(Label, { text: 'Project', focused: where === 'project' }),
      projectOptions.length
        ? h(Select, { options: projectOptions, value: form.project, onChange: (v: string) => dispatch({ type: 'project', value: v }), focus: where === 'project' && adding === null && picking === null })
        : h(Text, { color: theme.red }, 'No projects yet. Add one on the Projects tab.'),
    ),
    h(Text, null, ' '),
    // Rounds
    h(
      Box,
      null,
      h(Label, { text: 'Rounds', focused: where === 'rounds' }),
      producer
        ? h(
            Text,
            null,
            h(Text, { bold: where === 'rounds', color: where === 'rounds' ? theme.accent : undefined }, ` ${form.rounds} `),
            h(Text, { color: theme.dim }, '  tries at Plan or Dev before the card parks'),
          )
        : h(Text, { color: theme.dim }, '1   fixed: no step here can be sent back'),
    ),
    h(Text, null, ' '),
    h(Text, { color: theme.accent, wrap: 'truncate-end' }, summaryLine(form, catalog)),
    ...warnings.map((w, i) => h(Text, { key: `w${i}`, color: theme.yellow, wrap: 'truncate-end' }, `! ${w}`)),
    attempted && problems.length ? h(Box, { flexDirection: 'column', marginTop: 1 }, ...problems.map((p, i) => h(Text, { key: i, color: theme.red }, `! ${p}`))) : null,
    error ? h(Box, { marginTop: 1 }, h(Text, { color: theme.red }, error)) : null,
    busy ? h(Text, { color: theme.dim }, 'Saving...') : null,
  );
}

export const workflowFormScreen: Screen = {
  id: 'agents.workflow.form',
  title: (p) => ['Workflows', typeof p.name === 'string' ? `Edit ${p.name}` : 'New workflow'],
  component: (props) => h(WorkflowForm, { params: props.params }),
  hints: () => KEY_HINTS,
};
