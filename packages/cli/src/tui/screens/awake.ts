// Awake: the full status, the last lines of the watchdog log, and the three
// things you do with it (turn on, turn off, read the whole log). Each action
// runs the real command: vsf awake on / off.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../../config.ts';
import { useData, type AwakeStatus } from '../data.ts';
import { useBackGuard, useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { clock, minutesText } from '../format.ts';
import { theme } from '../theme.ts';
import { Lines, Panel, Select, seg, TextInput, type Line } from '../widgets.ts';
import type { Screen } from '../screens.ts';
import { scrollBy, tailLines } from './list-window.ts';

const h = React.createElement;

export type AwakeFull = AwakeStatus & { heat?: boolean; revertOnReboot?: boolean };

export const logFile = (dir: string = configDir()): string => join(dir, 'awake', 'watchdog.log');

// The tail of a file without reading all of a huge log.
export function readTail(path: string, maxBytes = 256 * 1024): string {
  try {
    if (!existsSync(path)) return '';
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

// ---- the status block -----------------------------------------------------

export function statusLines(a: AwakeFull): Line[] {
  const label = (t: string) => seg(t.padEnd(12), theme.dim);
  const power = a.power.onBattery ? `on battery, ${a.power.percent ?? '?'}%` : 'on power adapter';
  const lines: Line[] = [];
  if (a.on) lines.push([seg('● ', theme.green), seg(`On since ${a.since ? clock(new Date(a.since)) : '?'}, the lid can close`, undefined, { bold: true })]);
  else if (a.sleepDisabledByOther) lines.push([seg('● ', theme.yellow), seg('Sleep is off, but not by VoidShift')]);
  else lines.push([seg('○ ', theme.dim), seg('Off. The Mac sleeps normally.')]);
  lines.push([]);
  if (a.on) {
    lines.push([label('Until'), seg(a.until ? `${clock(new Date(a.until))}${a.minutesLeft !== null ? ` (${minutesText(a.minutesLeft)} left)` : ''}` : 'no end time')]);
  }
  lines.push([label('Battery'), seg(`floor ${a.batteryFloor}%, `), a.floorApplies ? seg('applies now (on battery)') : seg('does not apply while on power', theme.dim)]);
  lines.push([label('Power'), seg(power)]);
  lines.push([label('Watchdog'), a.watchdog ? seg('ok, checks every minute', theme.green) : seg('not loaded, guardrails will not act. vsf setup awake', theme.yellow)]);
  if (a.lastReason) lines.push([label('Last ended'), seg(a.lastReason)]);
  lines.push([
    label('Guardrails'),
    seg(`heat stop ${a.heat === false ? 'off' : 'on'}`, a.heat === false ? theme.yellow : undefined),
    seg(' · '),
    seg(`turn off after reboot ${a.revertOnReboot === false ? 'off' : 'on'}`, a.revertOnReboot === false ? theme.yellow : undefined),
  ]);
  return lines;
}

// ---- the "turn on" form ---------------------------------------------------

export interface OnForm {
  mode: 'until' | 'for';
  value: string;
  battery: string;
}

export const emptyForm = (): OnForm => ({ mode: 'until', value: '', battery: '' });

// The vsf awake on arguments, or what is wrong with the form.
export function onArgs(f: OnForm): { args: string[] } | { error: string } {
  const args = ['awake', 'on'];
  const value = f.value.trim();
  if (value) args.push(f.mode === 'until' ? '--until' : '--for', value);
  const battery = f.battery.trim();
  if (battery) {
    if (!/^\d+$/.test(battery) || Number(battery) < 5 || Number(battery) > 95) return { error: 'Battery takes a whole percentage from 5 to 95.' };
    args.push('--battery', battery);
  }
  return { args };
}

// A short plain-English line of what the form will do.
export function formSummary(f: OnForm): string {
  const value = f.value.trim();
  const when = !value ? 'with the default time limit' : f.mode === 'until' ? `until ${value}` : `for ${value}`;
  return `Keep the Mac awake ${when}${f.battery.trim() ? `, stopping at ${f.battery.trim()}% battery` : ''}.`;
}

const FIELDS = ['mode', 'value', 'battery'] as const;

function OnFormView(props: { form: OnForm; setForm(f: OnForm): void; onClose(): void }): React.ReactElement {
  const ctx = useScreen();
  const { form, setForm } = props;
  const [field, setField] = useState(0);
  const [error, setError] = useState('');
  const parsed = onArgs(form);

  const submit = async () => {
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const result = await ctx.actions.run({
      args: parsed.args,
      title: 'Turn awake on?',
      body: `${formSummary(form)} The lid can close and the Mac keeps running. The watchdog turns it off at the limit.`,
      confirmLabel: 'Turn on',
      cancelLabel: 'Not now',
    });
    if (result && result.code === 0) props.onClose();
  };

  useKeys(
    (input, key) => {
      if (key.escape) props.onClose();
      else if (key.tab) setField((i) => (i + (key.shift ? FIELDS.length - 1 : 1)) % FIELDS.length);
      else if (key.ctrl && input === 's') void submit();
    },
    { whileCapturing: true },
  );

  const row = (i: number, name: string, node: React.ReactNode, note?: string) =>
    h(
      Box,
      { key: name, flexDirection: 'row' },
      h(Text, { color: field === i ? theme.accent : theme.dim }, name.padEnd(15)),
      h(Box, { minWidth: 18 }, node),
      note ? h(Text, { color: theme.dim }, `  ${note}`) : null,
    );

  return h(
    Panel,
    { title: 'Turn awake on', focused: true },
    row(0, 'Stop', h(Select, { focus: field === 0, value: form.mode, onChange: (v: string) => setForm({ ...form, mode: v === 'for' ? 'for' : 'until' }), options: [{ value: 'until', label: 'At a time' }, { value: 'for', label: 'After a while' }] })),
    row(1, form.mode === 'until' ? 'Until' : 'For', h(TextInput, { focus: field === 1, value: form.value, onChange: (v: string) => setForm({ ...form, value: v }), placeholder: form.mode === 'until' ? '7am or 19:30' : '6h or 90m', onSubmit: () => void submit() }), 'leave empty for the default'),
    row(2, 'Battery floor', h(TextInput, { focus: field === 2, value: form.battery, onChange: (v: string) => setForm({ ...form, battery: v }), placeholder: '20', onSubmit: () => void submit() }), '5 to 95, stops here when on battery'),
    h(Box, { marginTop: 1 }, h(Text, { color: error ? theme.red : theme.dim }, error || formSummary(form))),
  );
}

// ---- the screen -----------------------------------------------------------

function Awake(): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const [mode, setMode] = useState<'main' | 'form' | 'log'>('main');
  const [log, setLog] = useState('');
  const [offset, setOffset] = useState(0);
  const [form, setForm] = useState<OnForm>(emptyForm());
  const a = state.awake as AwakeFull | null;

  // Refreshed live: read the log again every second and after each poll.
  useEffect(() => {
    const read = () => setLog(readTail(logFile()));
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, []);

  const size = Math.max(5, ctx.rows - 8);
  const maxOffset = Math.max(0, tailLines(log, 100000).length - size);

  useBackGuard(() => {
    if (mode === 'main') return false;
    setMode('main');
    return true;
  });

  useHints(
    mode === 'form'
      ? [{ key: 'tab', label: 'next field' }, { key: 'enter', label: 'turn on' }, { key: 'esc', label: 'cancel' }]
      : mode === 'log'
        ? [{ key: '↑↓', label: 'scroll' }, { key: 'G', label: 'latest' }, { key: 'l', label: 'close log' }, { key: 'esc', label: 'back' }]
        : ([{ key: 'o', label: 'turn on' }, { key: 'f', label: 'turn off' }, { key: 'l', label: 'full log' }, { key: 'esc', label: 'back' }] as Hint[]),
  );
  const formArgs = onArgs(form);
  useEquivalent(mode === 'main' ? ['awake', 'status'] : mode === 'form' ? ('args' in formArgs ? formArgs.args : ['awake', 'on']) : null);

  useKeys((input, key) => {
    if (mode === 'form') return;
    if (mode === 'log') {
      const total = tailLines(log, 100000).length;
      if (key.upArrow) setOffset((o) => scrollBy(o, 1, maxOffset));
      else if (key.downArrow) setOffset((o) => scrollBy(o, -1, maxOffset));
      else if (key.pageUp) setOffset((o) => scrollBy(o, size - 1, maxOffset));
      else if (key.pageDown) setOffset((o) => scrollBy(o, -(size - 1), maxOffset));
      else if (input === 'G') setOffset(0);
      else if (input === 'g') setOffset(Math.max(0, total - size));
      else if (input === 'l') setMode('main');
      return;
    }
    if (input === 'o') {
      setForm(emptyForm());
      setMode('form');
    }
    else if (input === 'f') {
      void ctx.actions.run({
        args: ['awake', 'off'],
        title: 'Turn awake off?',
        body: 'The Mac goes back to sleeping normally when the lid closes.',
        confirmLabel: 'Turn off',
        cancelLabel: 'Keep awake',
      });
    } else if (input === 'l') {
      setOffset(0);
      setMode('log');
    }
  });

  if (!a) {
    return h(Box, { paddingX: 1 }, h(Text, { color: state.errors.awake ? theme.red : theme.dim }, state.errors.awake ?? (state.loaded ? 'awake is not added. Run vsf add awake.' : 'Loading...')));
  }

  if (mode === 'form') return h(OnFormView, { form, setForm, onClose: () => setMode('main') });

  if (mode === 'log') {
    const lines = tailLines(log, 100000);
    const end = lines.length - offset;
    const shown = lines.slice(Math.max(0, end - size), end);
    return h(
      Panel,
      { title: 'Watchdog log', focused: true, subtitle: offset ? `${offset} lines above the end` : 'following', flexGrow: 1 },
      shown.length ? h(Lines, { lines: shown.map((l) => [seg(l, theme.text)]) }) : h(Text, { color: theme.dim }, 'No watchdog log yet.'),
    );
  }

  const last = tailLines(log, 20);
  return h(
    Box,
    { flexDirection: 'column' },
    h(Panel, { title: 'Awake' }, h(Lines, { lines: statusLines(a) })),
    h(
      Panel,
      { title: 'Watchdog log', subtitle: 'last 20 lines' },
      last.length ? h(Lines, { lines: last.map((l) => [seg(l, theme.dim)]) }) : h(Text, { color: theme.dim }, 'No watchdog log yet.'),
    ),
  );
}

export const awakeScreen: Screen = {
  id: 'awake',
  title: 'Awake',
  component: () => h(Awake),
  hints: () => [{ key: 'o', label: 'turn on' }, { key: 'f', label: 'turn off' }, { key: 'l', label: 'full log' }, { key: 'esc', label: 'back' }],
};
