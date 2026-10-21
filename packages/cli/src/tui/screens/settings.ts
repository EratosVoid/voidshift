// Settings: every config key of each added tool, edited inline. Saving runs
// `vsf config set KEY VALUE`, so the same validation as the command applies.
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { flatten, mask, parseValue } from '../../dotted.ts';
import { useData } from '../data.ts';
import { useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { theme } from '../theme.ts';
import { Panel, TextInput } from '../widgets.ts';
import { fitCell } from '../widgets.ts';
import type { Screen } from '../screens.ts';
import { windowOf } from './list-window.ts';

const h = React.createElement;

// Big structured keys that have their own screens.
const SKIPPED = ['agents.projects', 'agents.workflows', 'agents.homes', 'agents.enabled', 'memory.homes'];

const HINTS: Record<string, string> = {
  'agents.engine': 'claude or codex',
  'agents.timeoutMinutes': 'minutes before a step is stopped',
  'agents.reviewState': 'Linear state for verified cards',
  'awake.battery': 'battery floor, 5 to 95',
  'awake.heat': 'stop when the Mac runs hot',
  'awake.revertOnReboot': 'turn off again after a reboot',
};

export interface SettingRow {
  key: string;
  // What is shown in the value column (secrets masked).
  shown: string;
  // The text to start an edit with.
  edit: string;
  secret: boolean;
  hint: string;
}

export const isSkipped = (key: string): boolean => SKIPPED.some((s) => key === s || key.startsWith(s + '.'));

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

// The text an edit starts with: strings as typed, everything else as JSON.
export function editText(value: unknown): string {
  if (typeof value === 'string') return parseValue(value) === value ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? '';
}

// The rows for one tool, with its name in front of every key ("agents.engine").
export function settingRows(tool: string, config: Record<string, unknown> | null): SettingRow[] {
  const rows: SettingRow[] = [];
  for (const [path, value] of flatten(config ?? {})) {
    const key = `${tool}.${path}`;
    if (isSkipped(key)) continue;
    const masked = mask(key, value);
    const secret = masked !== value;
    rows.push({ key, shown: show(masked), edit: secret ? '' : editText(value), secret, hint: HINTS[key] ?? '' });
  }
  return rows;
}

// True when the tool has settings that live on other screens.
export const hasOtherScreens = (tool: string, config: Record<string, unknown> | null): boolean =>
  Object.keys(config ?? {}).some((k) => isSkipped(`${tool}.${k}`));

// `vsf config set KEY -- VALUE` keeps a value like -5 from being read as a flag.
export const setArgs = (key: string, value: string): string[] => ['config', 'set', key, ...(value.startsWith('-') ? ['--'] : []), value];
export const unsetArgs = (key: string): string[] => ['config', 'unset', key];

// The command's own problem line, for showing next to the row.
export function problemLine(output: string): string {
  return output.split('\n').map((l) => l.trim()).find(Boolean) ?? 'The change was not saved.';
}

export const nextIndex = (count: number, index: number, delta: number): number => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, index + delta)));

const BASE_HINTS: Hint[] = [
  { key: 'enter', label: 'edit' },
  { key: 'u', label: 'reset' },
  { key: 'e', label: '$EDITOR' },
  { key: 'esc', label: 'back' },
];

function Settings(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const data = useData();
  const tools = data.state.tools.filter((t) => data.readConfig(t) !== null);
  const wanted = typeof props.params.tool === 'string' ? props.params.tool : tools[0];
  const [toolName, setToolName] = useState<string | undefined>(wanted);
  const tool = toolName && tools.includes(toolName) ? toolName : tools[0];
  const config = tool ? data.readConfig(tool) : null;
  const rows = settingRows(tool ?? '', config);
  const [sel, setSel] = useState(0);
  const at = Math.min(sel, Math.max(0, rows.length - 1));
  const row = rows[at];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useHints(editing ? [{ key: 'enter', label: 'save' }, { key: 'esc', label: 'cancel edit' }] : tools.length > 1 ? [...BASE_HINTS.slice(0, 3), { key: 'tab', label: 'tool' }, BASE_HINTS[3]!] : BASE_HINTS);
  useEquivalent(row ? (editing ? setArgs(row.key, text) : ['config', 'set', row.key]) : null);

  const save = async (value: string) => {
    if (!row || saving) return;
    setSaving(true);
    const result = await ctx.actions.run({ args: setArgs(row.key, value), title: `Save ${row.key}`, noConfirm: true, done: `Saved ${row.key}` });
    setSaving(false);
    if (result && result.code === 0) {
      setEditing(false);
      setError('');
    } else if (result) setError(problemLine(result.output));
  };

  useKeys(
    (input, key) => {
      if (editing) {
        if (key.escape) {
          setEditing(false);
          setError('');
        }
        return;
      }
      if (key.upArrow) setSel(nextIndex(rows.length, at, -1));
      else if (key.downArrow) setSel(nextIndex(rows.length, at, 1));
      else if (key.tab && tools.length > 1) {
        const i = tools.indexOf(tool ?? '');
        setToolName(tools[(i + (key.shift ? tools.length - 1 : 1)) % tools.length]);
        setSel(0);
        setError('');
      } else if (key.return && row) {
        setText(row.edit);
        setError('');
        setEditing(true);
      } else if (input === 'u' && row) {
        void ctx.actions.run({
          args: unsetArgs(row.key),
          title: `Reset ${row.key}?`,
          body: 'Removes your saved value, so the default applies again.',
          confirmLabel: 'Reset',
          cancelLabel: 'Keep it',
        });
      } else if (input === 'e' && tool) void ctx.actions.terminal(['config', 'edit', tool]);
    },
    { whileCapturing: true },
  );

  if (!tool) {
    return h(Box, { paddingX: 1 }, h(Text, { color: theme.dim }, 'No added tool has settings yet.'));
  }

  const keyWidth = Math.min(34, Math.max(12, ...rows.map((r) => r.key.length - tool.length)) + 2);
  const valueWidth = Math.min(26, Math.max(10, ...rows.map((r) => r.shown.length)) + 2);
  const size = Math.max(4, ctx.rows - 14);
  const win = windowOf(rows.length, at, size);
  const other = hasOtherScreens(tool, config);

  return h(
    Box,
    { flexDirection: 'row' },
    h(
      Panel,
      { title: 'Tools', width: 16 },
      ...tools.map((t) => h(Text, { key: t, color: t === tool ? theme.bold : theme.text, bold: t === tool }, `${t === tool ? '▶' : ' '} ${t}`)),
    ),
    h(
      Panel,
      { title: tool, focused: true, flexGrow: 1 },
      rows.length === 0 ? h(Text, { color: theme.dim }, 'Nothing is saved yet. Defaults apply.') : null,
      ...rows.slice(win.start, win.end).map((r, i) => {
        const index = win.start + i;
        const on = index === at;
        const bg = on ? theme.selected : undefined;
        const name = r.key.slice(tool.length + 1);
        return h(
          Box,
          { key: r.key, flexDirection: 'row' },
          h(Text, { backgroundColor: bg, color: theme.accent }, on ? '▶ ' : '  '),
          h(Text, { backgroundColor: bg, bold: on, color: on ? theme.bold : theme.text }, fitCell(name, keyWidth)),
          on && editing
            ? h(Box, { flexGrow: 1 }, h(TextInput, { value: text, onChange: setText, mask: r.secret, onSubmit: (v: string) => void save(v) }))
            : h(Text, { backgroundColor: bg, bold: on }, fitCell(r.shown, valueWidth)),
          on && error
            ? h(Text, { color: theme.red, wrap: 'truncate-end' }, ` ${error}`)
            : on && editing
              ? null
              : h(Text, { color: theme.dim, wrap: 'truncate-end' }, ` ${r.hint}`),
        );
      }),
      rows.length > win.end - win.start ? h(Text, { color: theme.dim }, `${win.start + 1} to ${win.end} of ${rows.length}`) : null,
      other ? h(Box, { marginTop: 1 }, h(Text, { color: theme.dim }, 'Projects, workflows and folders have their own screens.')) : null,
    ),
  );
}

export const settingsScreen: Screen = {
  id: 'settings',
  title: 'Settings',
  component: (props) => h(Settings, { params: props.params }),
  hints: () => BASE_HINTS,
};
