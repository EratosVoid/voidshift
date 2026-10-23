// The live log screen: steps on the left, the selected step's log on the right,
// following the end of the file like tail -f.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { useHints, useKeys, useScreen } from '../context.ts';
import { useData, type RunItem } from '../data.ts';
import { Lines, Panel, seg, type Line } from '../widgets.ts';
import { theme } from '../theme.ts';
import type { Screen } from '../screens.ts';
import { cancelSpec, liveRunFor, settledSteps, stepDuration, stepMark } from './runs.ts';

const h = React.createElement;

export const POLL_LOG_MS = 500;
const MAX_LINES = 5000;
const FIRST_READ_BYTES = 512 * 1024;

// ---- pure helpers ----------------------------------------------------------

export interface LogText {
  lines: string[];
  partial: string;
}

const clean = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

// Adds a freshly read chunk: whole lines are kept, the unfinished one waits.
export function appendChunk(text: LogText, chunk: string): LogText {
  const parts = (text.partial + clean(chunk)).split('\n');
  const partial = parts.pop() ?? '';
  const lines = text.lines.concat(parts);
  return { lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines, partial };
}

// Wraps every line to rows of at most `width` characters, breaking at spaces.
// Only a word longer than the width is cut mid-word. Blank lines stay.
export function wrapLines(lines: string[], width: number): string[] {
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= w) {
      out.push(line);
      continue;
    }
    let row = '';
    let broke = false;
    for (const tok of line.match(/\S+|\s+/g) ?? []) {
      if (/^\s/.test(tok)) {
        // Spaces that would start a wrapped row, or overflow this one, are dropped.
        if (row.length + tok.length <= w && !(broke && row === '')) row += tok;
        continue;
      }
      if (row.length + tok.length <= w) {
        row += tok;
        continue;
      }
      if (row.trim() !== '') {
        out.push(row.trimEnd());
        broke = true;
      }
      row = tok;
      while (row.length > w) {
        out.push(row.slice(0, w));
        broke = true;
        row = row.slice(w);
      }
    }
    out.push(row.trimEnd());
  }
  return out;
}

export interface Scroll {
  // First visible row; null while following the end.
  top: number | null;
}

export const bottomTop = (total: number, size: number): number => Math.max(0, total - size);

export function scrollBy(s: Scroll, total: number, size: number, delta: number): Scroll {
  const cur = s.top ?? bottomTop(total, size);
  return { top: Math.max(0, Math.min(bottomTop(total, size), cur + delta)) };
}

export function visibleRows(rows: string[], size: number, s: Scroll): string[] {
  const top = s.top === null ? bottomTop(rows.length, size) : Math.min(s.top, bottomTop(rows.length, size));
  return rows.slice(top, top + size);
}

// Log name for a step: its recorded file, else a file that names the step.
export function logFor(run: RunItem, step: string | undefined): string | undefined {
  const steps = run.record?.steps ?? [];
  if (step) {
    const rec = [...steps].reverse().find((s) => s.step === step || s.label === step);
    if (rec?.log && run.logs.includes(rec.log)) return rec.log;
    const byName = [...run.logs].reverse().find((l) => l.includes(step.replace(/^vs-/, '')));
    if (byName) return byName;
  }
  const running = [...steps].reverse().find((s) => !s.endedAt)?.log;
  if (running && run.logs.includes(running)) return running;
  return run.logs[run.logs.length - 1];
}

export function lineColour(line: string): string | undefined {
  if (line.startsWith('$ ')) return theme.accent;
  if (/^\s*(✓|PASS)/.test(line)) return theme.green;
  if (/^\s*(✗|FAIL|Error)/.test(line)) return theme.red;
  return undefined;
}

// ---- tailing a file --------------------------------------------------------

// Reads the file once, then only the bytes added since, every 500ms.
export function useTail(path: string | null): LogText & { missing: boolean } {
  const [text, setText] = useState<LogText & { missing: boolean }>({ lines: [], partial: '', missing: false });
  useEffect(() => {
    setText({ lines: [], partial: '', missing: false });
    if (!path) return;
    let offset = -1;
    let acc: LogText = { lines: [], partial: '' };
    let decoder = new StringDecoder('utf8');
    const tick = () => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        setText((t) => (t.missing ? t : { ...t, missing: true }));
        return;
      }
      if (offset < 0) {
        offset = Math.max(0, size - FIRST_READ_BYTES);
        if (offset > 0) acc = { lines: [], partial: '' };
      } else if (size < offset) {
        offset = 0;
        acc = { lines: [], partial: '' };
        decoder = new StringDecoder('utf8');
      } else if (size === offset) return;
      try {
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(size - offset);
          const n = readSync(fd, buf, 0, buf.length, offset);
          offset += n;
          acc = appendChunk(acc, decoder.write(buf.subarray(0, n)));
        } finally {
          closeSync(fd);
        }
        setText({ ...acc, missing: false });
      } catch {
        // try again next tick
      }
    };
    tick();
    const t = setInterval(tick, POLL_LOG_MS);
    return () => clearInterval(t);
  }, [path]);
  return text;
}

// ---- the screen ------------------------------------------------------------

const LEFT = 24;

export function LogView(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const card = String(props.params.card ?? '');
  const dir = typeof props.params.dir === 'string' ? props.params.dir : null;
  const run = state.runs.find((r) => (dir ? r.dir === dir : r.card === card));
  const cur = liveRunFor(run, state);
  const live = !!cur;
  const record = run?.record;

  const [picked, setPicked] = useState<string | null>(null);
  const [scroll, setScroll] = useState<Scroll>({ top: null });
  const wanted = typeof props.params.step === 'string' ? props.params.step : undefined;
  const autoFile = run ? logFor(run, picked ? undefined : wanted) : undefined;
  // Until the user picks a log, a live run moves on to the newest one.
  const followNewest = !picked && live && !!run && run.logs.length > 0;
  const file = picked ?? (followNewest ? run!.logs[run!.logs.length - 1] : autoFile);
  const path = run && file ? join(run.dir, file) : null;
  const text = useTail(path);

  const rightWidth = Math.max(30, ctx.columns - LEFT - 1);
  const panelHeight = Math.max(6, ctx.rows - 4);
  const size = panelHeight - 2;
  const all = text.partial ? [...text.lines, text.partial] : text.lines;
  const rows = useMemo(() => wrapLines(all, rightWidth - 4), [text.lines, text.partial, rightWidth]);
  const following = scroll.top === null;

  const hints = [
    { key: 'f', label: following ? 'follow off' : 'follow on' },
    { key: '↑↓', label: 'scroll' },
    { key: '1-9', label: 'step' },
    { key: 'c', label: 'cancel card' },
    { key: 'esc', label: 'back' },
  ];
  useHints(hints);
  useEffect(() => {
    ctx.setHeaderRight(following ? 'following' : 'scrolled', following ? theme.accent : theme.dim);
    return () => ctx.setHeaderRight(null);
  }, [following]);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  useKeys((input, key) => {
    const total = rows.length;
    if (input === 'f') setScroll(following ? { top: bottomTop(total, size) } : { top: null });
    else if (key.upArrow) setScroll((s) => scrollBy(s, total, size, -1));
    else if (key.downArrow) setScroll((s) => scrollBy(s, total, size, 1));
    else if (key.pageUp) setScroll((s) => scrollBy(s, total, size, -(size - 1)));
    else if (key.pageDown) setScroll((s) => scrollBy(s, total, size, size - 1));
    else if (/^[1-9]$/.test(input) && run) {
      const name = run.logs[Number(input) - 1];
      if (name) {
        setPicked(name);
        setScroll({ top: null });
      }
    } else if (input === 'c') {
      if (!live) ctx.toast(`${card} is not running, so there is nothing to cancel.`, 'info');
      else void ctx.actions.run(cancelSpec(card, cur?.step));
    }
  });

  if (!run) {
    return h(Panel, { title: card || 'Log' }, h(Text, { color: theme.dim }, state.loaded ? `No saved run for ${card}.` : 'Loading...'));
  }

  // Left: steps, round, log files.
  const steps = settledSteps(run, state);
  const left: Line[] = steps.map((s) => {
    const m = stepMark(s);
    const on = !!file && s.log === file;
    return [seg(`${m.glyph} `, m.colour), seg(s.label.padEnd(8), on ? theme.accent : undefined, { bold: on }), seg(stepDuration(s, now), theme.dim)];
  });
  if (!steps.length) left.push([seg('No steps yet', theme.dim)]);
  const workflow = state.workflows.find((w) => w.name === record?.workflow);
  // The lock's round is 1-based like the card's label; 0 before the first.
  const round = cur?.round ? cur.round : Math.max(1, steps.filter((s) => s.step === steps[0]?.step).length);
  left.push([], [seg(`round ${round}${workflow?.maxRounds ? ` of ${workflow.maxRounds}` : ''}`, theme.dim)], []);
  run.logs.forEach((l) => {
    const on = l === file;
    left.push([seg(on ? '▶ ' : '  ', theme.accent), seg(l, on ? theme.accent : theme.dim, { bold: on })]);
  });

  const view = visibleRows(rows, size, scroll);
  const body = text.missing
    ? [h(Text, { key: 'm', color: theme.dim }, 'This log has not been written yet.')]
    : view.map((r, i) => h(Text, { key: i, wrap: 'truncate-end', color: lineColour(r) }, r || ' '));
  if (!text.missing && live && following && view.length < size) body.push(h(Text, { key: 'cur', color: theme.accent }, '▍'));

  return h(
    Box,
    { flexDirection: 'row' },
    h(Panel, { title: 'Steps', width: LEFT, height: panelHeight }, h(Lines, { lines: left })),
    h(Box, { width: 1 }),
    h(Panel, { title: file ?? 'Log', focused: true, width: rightWidth, height: panelHeight, subtitle: rows.length > size && !following ? `${(scroll.top ?? 0) + 1}/${rows.length}` : undefined }, ...body),
  );
}

// The step's name for the header: "QA log".
export const logTitle = (p: Record<string, unknown>): string[] => {
  const label = typeof p.stepLabel === 'string' ? p.stepLabel : typeof p.step === 'string' ? p.step.replace(/^vs-/, '') : '';
  return [String(p.card ?? 'Log'), label ? `${label} log` : 'Log'];
};

export const logScreen: Screen = {
  id: 'agents.log',
  title: logTitle,
  component: LogView,
  hints: () => [
    { key: 'f', label: 'follow on/off' },
    { key: '↑↓', label: 'scroll' },
    { key: '1-9', label: 'step' },
    { key: 'c', label: 'cancel card' },
    { key: 'esc', label: 'back' },
  ],
};
