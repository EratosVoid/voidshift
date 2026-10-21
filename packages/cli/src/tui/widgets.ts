// Reusable pieces for every screen: a titled box, the key hints footer, a
// table, step progress, outcome badges, a confirm dialog, and the two form
// fields (TextInput and Select). Elements are built with React.createElement
// because Node's type stripping does not run JSX.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useWindowSize, type Key } from 'ink';
import { useCapture, useScreen, type Hint } from './context.ts';
import { theme } from './theme.ts';

const h = React.createElement;

// ---- Panel: rounded box with a title in the top border -------------------

export interface PanelProps {
  title: string;
  // Accent border when focused.
  focused?: boolean;
  // Overrides the border colour (e.g. yellow for a warning).
  colour?: string;
  width?: number | string;
  height?: number;
  flexGrow?: number;
  // Shown dim after the title.
  subtitle?: string;
  children?: React.ReactNode;
}

export function Panel(props: PanelProps): React.ReactElement {
  const colour = props.colour ?? (props.focused ? theme.accent : theme.dim);
  const top = h(
    Box,
    { flexDirection: 'row', flexShrink: 0, height: 1 },
    h(
      Box,
      { flexShrink: 0 },
      h(
        Text,
        { wrap: 'truncate-end' },
        h(Text, { color: colour }, '╭─ '),
        h(Text, { bold: true, color: theme.bold }, props.title),
        props.subtitle ? h(Text, { color: theme.dim }, ` ${props.subtitle}`) : null,
        h(Text, { color: colour }, ' '),
      ),
    ),
    // A rule far longer than any terminal, clipped to whatever width is left.
    h(Box, { flexGrow: 1, flexBasis: 0, height: 1, overflow: 'hidden' }, h(Text, { color: colour }, '─'.repeat(400))),
    h(Box, { flexShrink: 0 }, h(Text, { color: colour }, '╮')),
  );
  const body = h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderTop: false, borderColor: colour, paddingX: 1, flexGrow: 1 },
    props.children,
  );
  return h(Box, { flexDirection: 'column', width: props.width, height: props.height, flexGrow: props.flexGrow }, top, body);
}

// ---- Rich lines: a line is a list of coloured segments --------------------

export interface Seg {
  text: string;
  colour?: string;
  bold?: boolean;
  dim?: boolean;
  bg?: string;
}
export type Line = Seg[];

export const seg = (text: string, colour?: string, extra: Partial<Seg> = {}): Seg => ({ text, colour, ...extra });

const segNodes = (line: Line) =>
  line.map((s, j) => h(Text, { key: j, color: s.colour, bold: s.bold, dimColor: s.dim, backgroundColor: s.bg }, s.text));

export function Lines(props: { lines: Line[] }): React.ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    ...props.lines.map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, ...(line.length ? segNodes(line) : [' ']))),
  );
}

// A row with text on the left and text pushed to the right edge.
export function SplitRow(props: { left: Line; right?: Line }): React.ReactElement {
  return h(
    Box,
    { flexDirection: 'row' },
    h(Box, { flexShrink: 1, flexGrow: 1 }, h(Text, { wrap: 'truncate-end' }, ...segNodes(props.left))),
    props.right?.length ? h(Box, { flexShrink: 0, marginLeft: 2 }, h(Text, null, ...segNodes(props.right))) : null,
  );
}

// ---- KeyHints footer -----------------------------------------------------

// Width of one hint as drawn: " key " + " label  ".
const hintWidth = (hint: Hint): number => hint.key.length + hint.label.length + 5;

export interface FooterLayout {
  // Hints, one array per line.
  rows: Hint[][];
  // The "= vsf ..." command, cut to the width, or null when there is none.
  command: string | null;
  // True when the command sits at the right end of the single hints line.
  inline: boolean;
}

// Lays out the footer for `width` columns (inside the padding). Hints and the
// command share one line when they fit. Otherwise the hints wrap onto as many
// lines as they need and the command gets its own line below, cut with an
// ellipsis only if it is longer than the width. Hints are never cut.
export function layoutFooter(hints: Hint[], command: string | undefined, width: number): FooterLayout {
  const w = Math.max(10, width);
  const total = hints.reduce((n, hint) => n + hintWidth(hint), 0) - 2;
  if (!command && total + 2 <= w) return { rows: [hints], command: null, inline: false };
  if (command && total + 2 + command.length <= w) return { rows: [hints], command, inline: true };
  const rows: Hint[][] = [];
  let row: Hint[] = [];
  let used = 0;
  for (const hint of hints) {
    const hw = hintWidth(hint);
    if (row.length && used + hw > w) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(hint);
    used += hw;
  }
  if (row.length) rows.push(row);
  if (!command) return { rows, command: null, inline: false };
  return { rows, command: command.length > w ? command.slice(0, w - 1) + '…' : command, inline: false };
}

export function KeyHints(props: { hints: Hint[]; right?: string; width?: number }): React.ReactElement {
  const win = useWindowSize();
  const layout = layoutFooter(props.hints, props.right, (props.width ?? win.columns) - 2);
  const rowNode = (row: Hint[], r: number) =>
    h(
      Text,
      { key: r, wrap: 'truncate-end' },
      ...row.flatMap((hint, i) => [
        h(Text, { key: `k${i}`, backgroundColor: theme.keycap, color: theme.keycapText }, ` ${hint.key} `),
        h(Text, { key: `l${i}`, color: theme.text }, ` ${hint.label}  `),
      ]),
    );
  if (layout.inline) {
    return h(
      Box,
      { flexDirection: 'row', paddingX: 1 },
      h(Box, { flexGrow: 1, flexShrink: 1 }, rowNode(layout.rows[0]!, 0)),
      h(Box, { flexShrink: 0, marginLeft: 2 }, h(Text, { color: theme.dim }, layout.command)),
    );
  }
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...layout.rows.map(rowNode),
    layout.command ? h(Text, { key: 'cmd', color: theme.dim, wrap: 'truncate-end' }, layout.command) : null,
  );
}

// ---- Table ---------------------------------------------------------------

export type Cell = string | { text: string; colour?: string; bold?: boolean };

export interface Column {
  title: string;
  // Characters, including the gap to the next column. Omit on the last column.
  width?: number;
}

const cellText = (c: Cell) => (typeof c === 'string' ? c : c.text);
const cellColour = (c: Cell) => (typeof c === 'string' ? undefined : c.colour);

// Cuts or pads a cell to exactly `width` characters.
export function fitCell(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;
  return t.padEnd(width);
}

// A table cell in a column `width` wide: the text is cut so at least two spaces
// are left before the next column, then padded to the full width.
export function fitColumn(text: string, width: number): string {
  return fitCell(text, Math.max(1, width - 2)).padEnd(width);
}

export function Table(props: { columns: Column[]; rows: Cell[][]; selected?: number; empty?: string; marker?: boolean }): React.ReactElement {
  const marker = props.marker !== false;
  const line = (cells: Cell[], i: number, isHead: boolean) => {
    const sel = !isHead && i === props.selected;
    const bg = sel ? theme.selected : undefined;
    return h(
      Box,
      { key: isHead ? 'head' : i, flexDirection: 'row' },
      h(Text, { color: theme.accent, backgroundColor: bg }, marker ? (sel ? '▶ ' : '  ') : ''),
      ...props.columns.map((col, j) => {
        const cell = cells[j] ?? '';
        const text = col.width ? fitColumn(cellText(cell), col.width) : cellText(cell);
        const bold = sel || (typeof cell !== 'string' && cell.bold);
        const node = h(Text, { wrap: 'truncate-end', color: isHead ? theme.dim : cellColour(cell), bold, backgroundColor: bg }, text);
        return col.width ? h(Box, { key: j, width: col.width, flexShrink: 0 }, node) : h(Box, { key: j, flexGrow: 1, flexShrink: 1 }, node);
      }),
    );
  };
  return h(
    Box,
    { flexDirection: 'column' },
    line(props.columns.map((c) => c.title), -1, true),
    ...props.rows.map((r, i) => line(r, i, false)),
    props.rows.length === 0 && props.empty ? h(Text, { color: theme.dim }, props.empty) : null,
  );
}

// ---- Sub-tabs -------------------------------------------------------------

export function SubTabs(props: { tabs: { id: string; label: string }[]; active: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  props.tabs.forEach((t, i) => {
    const on = t.id === props.active;
    parts.push(
      on
        ? h(Text, { key: i, backgroundColor: theme.accent, color: theme.onAccent }, ` ${t.label} `)
        : h(Text, { key: i, color: theme.text }, ` ${t.label} `),
    );
    parts.push(h(Text, { key: `s${i}` }, '  '));
  });
  return h(Box, { paddingLeft: 1 }, h(Text, null, ...parts));
}

// ---- Progress steps ------------------------------------------------------

export type StepState = 'done' | 'running' | 'pending' | 'failed';

export interface StepProgress {
  label: string;
  state: StepState;
  // 0 to 1, for the running step.
  fraction?: number;
}

// The three parts of a bar: filled, the head, the rest. Done is all filled.
export function barParts(state: StepState, fraction: number, width: number): { filled: string; head: string; rest: string } {
  if (state === 'done' || state === 'failed') return { filled: '━'.repeat(width), head: '', rest: '' };
  if (state === 'pending') return { filled: '', head: '', rest: '─'.repeat(width) };
  const n = Math.max(0, Math.min(width - 1, Math.round(Math.max(0, Math.min(1, fraction)) * (width - 1))));
  return { filled: '━'.repeat(n), head: '╸', rest: '─'.repeat(width - n - 1) };
}

// "Dev ━━━━━━━━━━━━ ✓   QA ━━━━━━╸──────"
export function ProgressSteps(props: { steps: StepProgress[]; barWidth?: number }): React.ReactElement {
  const width = props.barWidth ?? 12;
  const nodes: React.ReactNode[] = [];
  props.steps.forEach((s, i) => {
    const colour = s.state === 'done' ? theme.green : s.state === 'failed' ? theme.red : s.state === 'running' ? theme.accent : theme.dim;
    const bar = barParts(s.state, s.fraction ?? 0.5, width);
    nodes.push(
      h(
        Text,
        { key: i },
        h(Text, { color: colour }, `${s.label} ${bar.filled}${bar.head}`),
        h(Text, { color: theme.dim }, bar.rest),
        s.state === 'done' ? h(Text, { color: theme.green }, ' ✓') : s.state === 'failed' ? h(Text, { color: theme.red }, ' ✗') : null,
        i < props.steps.length - 1 ? h(Text, null, '   ') : null,
      ),
    );
  });
  return h(Text, null, ...nodes);
}

// ---- Badge ---------------------------------------------------------------

export function outcomeColour(outcome: string): string {
  switch (outcome) {
    case 'verified':
      return theme.green;
    case 'parked':
    case 'changes':
      return theme.yellow;
    case 'cancelled':
      return theme.red;
    case 'running':
      return theme.accent;
    default:
      return theme.dim;
  }
}

export function Badge(props: { outcome: string; label?: string }): React.ReactElement {
  return h(Text, { color: outcomeColour(props.outcome) }, props.label ?? props.outcome);
}

// ---- Confirm dialog ------------------------------------------------------

export interface ConfirmProps {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm(): void;
  onCancel(): void;
}

// Left and right choose, enter confirms, esc cancels, y and n are shortcuts.
export function Confirm(props: ConfirmProps): React.ReactElement {
  const [yes, setYes] = useState(true);
  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.tab) setYes((v) => !v);
    else if (key.return) (yes ? props.onConfirm : props.onCancel)();
    else if (key.escape || input === 'n') props.onCancel();
    else if (input === 'y') props.onConfirm();
  });
  const button = (label: string, on: boolean) =>
    on ? h(Text, { backgroundColor: theme.accent, color: theme.onAccent }, ` ${label} `) : h(Text, { color: theme.text }, ` ${label} `);
  return h(
    Box,
    { justifyContent: 'center', marginTop: 2 },
    h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: theme.accent, paddingX: 2, width: 66 },
      h(Text, { bold: true, color: theme.bold }, props.title),
      props.body ? h(Box, { marginTop: 1 }, h(Text, null, props.body)) : null,
      h(
        Box,
        { marginTop: 1, justifyContent: 'center', gap: 3 },
        button(props.confirmLabel ?? 'Yes', yes),
        button(props.cancelLabel ?? 'No', !yes),
      ),
    ),
  );
}

// ---- TextInput -----------------------------------------------------------

export interface EditResult {
  value: string;
  cursor: number;
}

// Applies one keypress to a single-line text value. Pure. Keys it does not
// own (enter, tab, esc, up, down) leave the value unchanged for the form to use.
export function editText(value: string, cursor: number, input: string, key: Partial<Key>): EditResult {
  const at = Math.max(0, Math.min(cursor, value.length));
  if (key.leftArrow) return { value, cursor: Math.max(0, at - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, at + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { value, cursor: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { value, cursor: value.length };
  if (key.backspace || key.delete) {
    if (at === 0) return { value, cursor: at };
    return { value: value.slice(0, at - 1) + value.slice(at), cursor: at - 1 };
  }
  if (key.ctrl && input === 'u') return { value: value.slice(at), cursor: 0 };
  if (key.ctrl && input === 'w') {
    const head = value.slice(0, at).replace(/\S+\s*$/, '');
    return { value: head + value.slice(at), cursor: head.length };
  }
  if (key.ctrl || key.meta || key.escape || key.return || key.tab || key.upArrow || key.downArrow || !input) return { value, cursor: at };
  // Pasted text arrives as one chunk; drop control characters and newlines.
  const clean = input.replace(/[\u0000-\u001f\u007f]/g, '');
  return { value: value.slice(0, at) + clean + value.slice(at), cursor: at + clean.length };
}

export interface TextInputProps {
  value: string;
  onChange(value: string): void;
  focus?: boolean;
  placeholder?: string;
  // Show bullets instead of the text.
  mask?: boolean;
  // Enter pressed in this field.
  onSubmit?(value: string): void;
}

export function TextInput(props: TextInputProps): React.ReactElement {
  const ctx = useScreen();
  const [cursor, setCursor] = useState(props.value.length);
  const focus = props.focus !== false;
  useCapture(focus);
  useInput(
    (input, key) => {
      if (key.return) {
        props.onSubmit?.(props.value);
        return;
      }
      const r = editText(props.value, cursor, input, key);
      if (r.value !== props.value) props.onChange(r.value);
      setCursor(r.cursor);
    },
    { isActive: focus && !ctx.modalOpen },
  );
  const shown = props.mask ? '•'.repeat(props.value.length) : props.value;
  const at = Math.min(cursor, shown.length);
  if (!focus) return h(Text, { color: shown ? undefined : theme.dim }, shown || props.placeholder || ' ');
  const on = { backgroundColor: theme.accent, color: theme.onAccent };
  return h(
    Text,
    { wrap: 'truncate-start' },
    h(Text, on, ` ${shown.slice(0, at)}`),
    h(Text, { inverse: true }, shown[at] ?? ' '),
    h(Text, on, `${shown.slice(at + 1)} `),
  );
}

// ---- Select --------------------------------------------------------------

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

// Next option index when moving by `delta`, wrapping around.
export function cycle(count: number, index: number, delta: number): number {
  return count === 0 ? 0 : (((index + delta) % count) + count) % count;
}

export interface SelectProps {
  options: Option[];
  value: string;
  onChange(value: string): void;
  focus?: boolean;
}

// Closed: "label ▾". Left and right change the value; enter opens the list,
// up and down move, enter picks, esc closes.
export function Select(props: SelectProps): React.ReactElement {
  const ctx = useScreen();
  const [open, setOpen] = useState(false);
  const idx = Math.max(0, props.options.findIndex((o) => o.value === props.value));
  const [hover, setHover] = useState(idx);
  const focus = props.focus !== false;
  useCapture(open);
  useEffect(() => {
    if (!focus) setOpen(false);
  }, [focus]);
  useInput(
    (_input, key) => {
      if (open) {
        if (key.upArrow) setHover((i) => cycle(props.options.length, i, -1));
        else if (key.downArrow) setHover((i) => cycle(props.options.length, i, 1));
        else if (key.return) {
          const o = props.options[hover];
          if (o) props.onChange(o.value);
          setOpen(false);
        } else if (key.escape) setOpen(false);
        return;
      }
      if (key.return) {
        setHover(idx);
        setOpen(true);
      } else if (key.leftArrow) props.onChange(props.options[cycle(props.options.length, idx, -1)]?.value ?? props.value);
      else if (key.rightArrow) props.onChange(props.options[cycle(props.options.length, idx, 1)]?.value ?? props.value);
    },
    { isActive: focus && !ctx.modalOpen },
  );
  const current = props.options[idx];
  const head = h(
    Text,
    null,
    h(Text, { backgroundColor: focus ? theme.accent : undefined, color: focus ? theme.onAccent : undefined }, ` ${current?.label ?? props.value} `),
    current?.hint ? h(Text, { color: theme.dim }, `  ${current.hint}`) : null,
    h(Text, { color: theme.dim }, '  ▾'),
  );
  if (!open) return head;
  return h(
    Box,
    { flexDirection: 'column' },
    head,
    ...props.options.map((o, i) =>
      h(
        Text,
        { key: o.value, backgroundColor: i === hover ? theme.selected : undefined, color: i === hover ? theme.bold : theme.text },
        `${i === hover ? '▶ ' : '  '}${o.label}`,
        o.hint ? h(Text, { color: theme.dim }, `  ${o.hint}`) : null,
      ),
    ),
  );
}
