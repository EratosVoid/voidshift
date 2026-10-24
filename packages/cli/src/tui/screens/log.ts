// The card view: everything about one card, or one scheduled job, on a single
// screen. Steps, attempts, PR and labels on the left, the selected step's log on
// the right following the end of the file like tail -f, and every action on it.
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { configDir } from '../../config.ts';
import { useBackGuard, useEquivalent, useHints, useKeys, useScreen, type Hint } from '../context.ts';
import { useData, type RunItem } from '../data.ts';
import { duration, tilde, truncate } from '../format.ts';
import { Lines, Panel, Select, outcomeColour, seg, type Line } from '../widgets.ts';
import { theme } from '../theme.ts';
import type { Screen } from '../screens.ts';
import { attemptsOf, cancelSpec, isLive, listRuns, liveRunFor, manualLogPath, outcomeOf, runMs, settledSteps, startedText, stepDuration, stepMark, useLabels, windowStart } from './runs.ts';

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

// ---- the card view ---------------------------------------------------------

const LEFT = 36;
const ATTEMPTS_SHOWN = 6;

// The runs a card view moves through, newest first: a job's runs, or a card's
// attempts. A card that only ever ran on a schedule still shows its runs.
export function viewRuns(runs: RunItem[], target: { card?: string; job?: string }): RunItem[] {
  if (target.job) return listRuns(runs, target.job);
  if (!target.card) return [];
  const attempts = attemptsOf(runs, target.card);
  return attempts.length ? attempts : runs.filter((r) => r.card === target.card);
}

export function cardHints(opts: { job: boolean; following: boolean; many: boolean; pick: boolean }): Hint[] {
  if (opts.pick)
    return [
      { key: '←→', label: 'choose step' },
      { key: 'enter', label: 'list' },
      { key: 'g', label: 'run' },
      { key: 'esc', label: 'cancel' },
    ];
  const hints: Hint[] = [{ key: 't', label: opts.following ? 'follow off' : 'follow on' }, { key: '↑↓', label: 'scroll' }, { key: '1-9', label: 'log' }];
  if (opts.many) hints.push({ key: '←→', label: opts.job ? 'run' : 'attempt' });
  hints.push({ key: 'c', label: 'cancel' });
  if (!opts.job) hints.push({ key: 'r', label: 'retry' }, { key: 'f', label: 'run from step' });
  hints.push({ key: 'esc', label: 'back' });
  return hints;
}

type Mode = 'view' | 'pick';

export function CardView(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const p = props.params;
  const card = typeof p.card === 'string' ? p.card : undefined;
  const job = typeof p.job === 'string' ? p.job : undefined;
  const all = useMemo(() => viewRuns(state.runs, { card, job }), [state.runs, card, job]);
  const [selDir, setSelDir] = useState<string | null>(typeof p.dir === 'string' ? p.dir : null);
  const found = selDir ? all.findIndex((r) => r.dir === selDir) : 0;
  const index = Math.max(0, found);
  const run: RunItem | undefined = all[index];
  const record = run?.record;
  const cur = liveRunFor(run, state);
  const live = !!cur;
  const scheduled = !!job || record?.source === 'cron';
  const labels = useLabels(index === 0 && record && !scheduled ? run!.card : undefined);

  const [mode, setMode] = useState<Mode>('view');
  const [from, setFrom] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [scroll, setScroll] = useState<Scroll>({ top: null });
  const wanted = typeof p.step === 'string' && run && run.dir === p.dir ? p.step : undefined;
  const autoFile = run ? logFor(run, picked ? undefined : wanted) : undefined;
  // Until a log is picked, a live run moves on to the newest one.
  const followNewest = !picked && live && !!run && run.logs.length > 0;
  const file = picked ?? (followNewest ? run!.logs[run!.logs.length - 1] : autoFile);
  const path = run && file ? join(run.dir, file) : null;
  const text = useTail(path);

  const rightWidth = Math.max(30, ctx.columns - LEFT - 1);
  const panelHeight = Math.max(6, ctx.rows - 4);
  const size = panelHeight - 2;
  const lines = text.partial ? [...text.lines, text.partial] : text.lines;
  const rows = useMemo(() => wrapLines(lines, rightWidth - 4), [text.lines, text.partial, rightWidth]);
  const following = scroll.top === null;

  const workflow = state.workflows.find((w) => w.name === record?.workflow);
  const stepIds = workflow?.steps ?? [...new Set((record?.steps ?? []).map((s) => s.step))];
  const labelOf = (id: string) => state.steps?.steps.find((s) => s.id === id)?.label ?? record?.steps.find((s) => s.step === id)?.label ?? id;
  const options = stepIds.map((id) => ({ value: id, label: labelOf(id) }));

  useHints(cardHints({ job: scheduled, following, many: all.length > 1, pick: mode === 'pick' }));
  useEquivalent(mode === 'pick' && run && from ? ['agents', 'run', run.card, '--from', from] : null);
  useEffect(() => {
    ctx.setHeaderRight(following ? 'following' : 'scrolled', following ? theme.accent : theme.dim);
    return () => ctx.setHeaderRight(null);
  }, [following]);
  useBackGuard(() => {
    if (mode !== 'pick') return false;
    setMode('view');
    return true;
  });

  const goTo = (i: number) => {
    const next = all[Math.max(0, Math.min(all.length - 1, i))];
    if (!next || next.dir === run?.dir) return;
    setSelDir(next.dir);
    setPicked(null);
    setScroll({ top: null });
  };

  useKeys((input, key) => {
    if (mode === 'pick') {
      if (!ctx.capturing && input === 'g' && run && from) {
        const label = labelOf(from);
        setMode('view');
        void ctx.actions
          .confirm({
            title: `Run ${run.card} from ${label}?`,
            body: `Starts the ${label} step of ${record?.workflow ?? 'the workflow'} on ${run.card} in the background. Watch it here as it runs. Output goes to ${tilde(manualLogPath(configDir()))}.`,
            confirmLabel: 'Run',
            cancelLabel: 'Cancel',
          })
          .then((ok) => {
            if (ok) ctx.actions.detach(['agents', 'run', run.card, '--from', from], manualLogPath(configDir()), `Started ${run.card} from ${label}`);
          });
      }
      return;
    }
    const total = rows.length;
    if (input === 't') setScroll(following ? { top: bottomTop(total, size) } : { top: null });
    else if (key.upArrow) setScroll((s) => scrollBy(s, total, size, -1));
    else if (key.downArrow) setScroll((s) => scrollBy(s, total, size, 1));
    else if (key.pageUp) setScroll((s) => scrollBy(s, total, size, -(size - 1)));
    else if (key.pageDown) setScroll((s) => scrollBy(s, total, size, size - 1));
    else if (key.rightArrow) goTo(index + 1);
    else if (key.leftArrow) goTo(index - 1);
    else if (!run) return;
    else if (/^[1-9]$/.test(input)) {
      const name = run.logs[Number(input) - 1];
      if (name) {
        setPicked(name);
        setScroll({ top: null });
      }
    } else if (input === 'c') {
      if (!live) ctx.toast(`${run.card} is not running, so there is nothing to cancel.`, 'info');
      else void ctx.actions.run(cancelSpec(run.card, cur?.step));
    } else if (input === 'r') {
      if (scheduled) ctx.toast('Scheduled runs are not retried. The job runs again on its schedule.', 'info');
      else
        void ctx.actions.run({
          args: ['agents', 'retry', run.card],
          title: `Retry ${run.card}?`,
          body: `Queues ${run.card} again. The runner picks it up on its next check.`,
          confirmLabel: 'Retry card',
          cancelLabel: 'Cancel',
          done: `${run.card} queued again`,
        });
    } else if (input === 'f') {
      if (scheduled) ctx.toast('Scheduled runs start on their schedule, not from a step.', 'info');
      else if (live) ctx.toast(`${run.card} is running. Cancel it first.`, 'info');
      else if (!options.length) ctx.toast('No steps known for this run.', 'info');
      else {
        const last = record?.steps[record.steps.length - 1]?.step;
        setFrom(last && stepIds.includes(last) ? last : stepIds[0]!);
        setMode('pick');
      }
    }
  }, { whileCapturing: true });

  const name = job ?? card ?? 'Card';
  if (!run) {
    return h(Panel, { title: name }, h(Text, { color: theme.dim }, state.loaded ? `No saved run for ${name}.` : 'Loading...'));
  }

  // Left: what the run is, its steps, its attempts, PR and labels, its logs.
  const width = LEFT - 4;
  const shownAs = outcomeOf(run, state);
  const ms = runMs(run, now, live);
  const left: Line[] = [];
  if (record?.title) left.push([seg(truncate(record.title, width), undefined, { bold: true })]);
  left.push([seg(shownAs, outcomeColour(shownAs)), seg(`  ${startedText(run)}${ms === null ? '' : `  ${duration(ms)}`}`, theme.dim)]);
  left.push([]);
  const steps = settledSteps(run, state);
  for (const s of steps) {
    const m = stepMark(s);
    const on = !!file && s.log === file;
    left.push([seg(`${m.glyph} `, m.colour), seg(s.label.padEnd(8), on ? theme.accent : undefined, { bold: on }), seg(stepDuration(s, now), theme.dim)]);
  }
  if (!steps.length) left.push([seg('No steps yet', theme.dim)]);
  // The lock's round is 1-based like the card's label; 0 before the first.
  const round = cur?.round ? cur.round : Math.max(1, steps.filter((s) => s.step === steps[0]?.step).length);
  if (!scheduled) left.push([seg(`round ${round}${workflow?.maxRounds ? ` of ${workflow.maxRounds}` : ''}`, theme.dim)]);
  const why = shownAs === 'failed' ? (record?.reason ?? 'The run stopped without finishing.') : record?.reason;
  if ((shownAs === 'parked' || shownAs === 'failed') && why) left.push([seg(shownAs === 'failed' ? 'Failed: ' : 'Parked: ', shownAs === 'failed' ? theme.red : theme.yellow), seg(why)]);

  if (all.length > 1) {
    left.push([], [seg(scheduled ? `Run ${index + 1} of ${all.length}` : `Attempt ${all.length - index} of ${all.length}`, theme.dim)]);
    const start = windowStart(all.length, index, ATTEMPTS_SHOWN, 0);
    for (const a of all.slice(start, start + ATTEMPTS_SHOWN)) {
      const on = a.dir === run.dir;
      const out = outcomeOf(a, state);
      const t = runMs(a, now, isLive(a, state));
      left.push([seg(on ? '▶ ' : '  ', theme.accent), seg(startedText(a), on ? undefined : theme.dim, { bold: on }), seg(`  ${out}`, outcomeColour(out)), seg(t === null ? '' : `  ${duration(t)}`, theme.dim)]);
    }
  }

  if (record?.prUrl || labels) left.push([]);
  if (record?.prUrl) left.push([seg('PR ', theme.dim), seg(record.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, ''), theme.accent)]);
  if (labels) left.push([seg('labels ', theme.dim), seg(labels.join(' ') || 'none')]);

  if (run.logs.length) left.push([]);
  run.logs.slice(0, 9).forEach((l, i) => {
    const on = l === file;
    left.push([seg(on ? '▶ ' : `${i + 1} `, on ? theme.accent : theme.dim), seg(l, on ? theme.accent : theme.dim, { bold: on })]);
  });

  const view = visibleRows(rows, size, scroll);
  const body = !run.logs.length
    ? [h(Text, { key: 'n', color: theme.dim }, 'This run has no logs yet.')]
    : text.missing
      ? [h(Text, { key: 'm', color: theme.dim }, 'This log has not been written yet.')]
      : view.map((r, i) => h(Text, { key: i, wrap: 'truncate-end', color: lineColour(r) }, r || ' '));
  if (run.logs.length && !text.missing && live && following && view.length < size) body.push(h(Text, { key: 'cur', color: theme.accent }, '▍'));

  return h(
    Box,
    { flexDirection: 'row' },
    h(
      Panel,
      { title: run.card, width: LEFT, height: panelHeight, focused: mode === 'pick' },
      h(Lines, { lines: left }),
      mode === 'pick' ? h(Box, { marginTop: 1, flexDirection: 'column' }, h(Text, { color: theme.dim }, 'Run from:'), h(Select, { options, value: from, onChange: setFrom })) : null,
    ),
    h(Box, { width: 1 }),
    h(Panel, { title: file ?? 'Log', focused: mode !== 'pick', width: rightWidth, height: panelHeight, subtitle: rows.length > size && !following ? `${(scroll.top ?? 0) + 1}/${rows.length}` : undefined }, ...body),
  );
}

// The header crumb: the card, or the job.
export const cardTitle = (p: Record<string, unknown>): string[] => [String(p.job ?? p.card ?? 'Card')];

export const cardScreen: Screen = {
  id: 'agents.card',
  title: cardTitle,
  component: CardView,
  hints: (props) => cardHints({ job: typeof props.params.job === 'string', following: true, many: false, pick: false }),
};
