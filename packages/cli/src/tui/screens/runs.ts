// The Runs tab of the agents screen: every run newest first, the selected run
// in detail below, and the keys to open it, cancel, retry, run from a
// step, clean old runs and filter. Every action is a real vsf command.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import { join } from 'node:path';
import { configDir } from '../../config.ts';
import { runAction } from '../actions.ts';
import { useBackGuard, useEquivalent, useHints, useKeys, useScreen, type ActionSpec, type Hint } from '../context.ts';
import { liveRunsOf, useData, type AgentsCurrent, type DataState, type RunItem, type StepRecord } from '../data.ts';
import { duration, folderStamp, stamp, tilde, truncate, usageText } from '../format.ts';
import { Lines, Panel, Select, Table, TextInput, outcomeColour, seg, type Cell, type Line } from '../widgets.ts';
import type { Screen } from '../screens.ts';
import { theme } from '../theme.ts';

const h = React.createElement;

// ---- pure helpers ----------------------------------------------------------

// Where "Run from step" writes the output of the detached run.
export const manualLogPath = (dir: string): string => join(dir, 'agents', 'manual.log');

// Shared with the agents shell: while the step picker is on screen, left and
// right belong to it, not to the tab bar.
export const tabLock = { on: false };

// Runs whose card or workflow contains the text (case does not matter).
export function filterRuns(runs: RunItem[], text: string): RunItem[] {
  const q = text.trim().toLowerCase();
  if (!q) return runs;
  return runs.filter((r) => r.card.toLowerCase().includes(q) || (r.record?.workflow ?? '').toLowerCase().includes(q));
}

// "Dev → QA": step labels in order, each once.
export function stepsLabel(steps: StepRecord[]): string {
  const seen: string[] = [];
  for (const s of steps) if (!seen.includes(s.label)) seen.push(s.label);
  return seen.join(' → ');
}

// How many times the first step started: the number of rounds begun.
export function roundsOf(steps: StepRecord[]): number {
  const first = steps[0]?.step;
  return first ? steps.filter((s) => s.step === first).length : 0;
}

// How long a run took. A run that is not live and has no end stopped at its
// last step, never at now.
export function runMs(run: RunItem, nowMs: number, live: boolean): number | null {
  const rec = run.record;
  if (!rec) return null;
  const start = Date.parse(rec.startedAt);
  if (Number.isNaN(start)) return null;
  const lastStep = rec.steps[rec.steps.length - 1];
  const endText = rec.endedAt ?? (live ? undefined : (lastStep?.endedAt ?? lastStep?.startedAt ?? rec.startedAt));
  const end = endText ? Date.parse(endText) : nowMs;
  return Math.max(0, (Number.isNaN(end) ? start : end) - start);
}

// The runs the list shows. With a job: that scheduled workflow's runs. Without:
// no scheduled runs, and one row per card (its latest run). Newest first in, newest first out.
export function listRuns(runs: RunItem[], job: string | null): RunItem[] {
  if (job) return runs.filter((r) => r.record?.source === 'cron' && r.record.workflow === job);
  const seen = new Set<string>();
  return runs.filter((r) => {
    if (r.record?.source === 'cron' || seen.has(r.card)) return false;
    seen.add(r.card);
    return true;
  });
}

// Every non-scheduled run of a card, newest first.
export const attemptsOf = (runs: RunItem[], card: string): RunItem[] => runs.filter((r) => r.card === card && r.record?.source !== 'cron');

// The outcome shown for a run. A run that says "running" while no live run
// is on its card was cut off, so it failed.
export function outcomeOf(run: RunItem, state: Pick<DataState, 'agents'>): string {
  const outcome = run.record?.outcome;
  if (!outcome) return 'old run';
  if (outcome === 'running' && state.agents && !liveRunsOf(state.agents).some((c) => c.card === run.card)) return 'failed';
  return outcome;
}

// The live run working on this run, if any.
export function liveRunFor(run: RunItem | undefined, state: Pick<DataState, 'agents'>): AgentsCurrent | undefined {
  if (!run || run.record?.outcome !== 'running') return undefined;
  return liveRunsOf(state.agents).find((cur) => cur.card === run.card && (!cur.runDir || cur.runDir === run.dir));
}

export const isLive = (run: RunItem | undefined, state: Pick<DataState, 'agents'>): boolean => !!liveRunFor(run, state);

export function startedText(run: RunItem): string {
  const t = run.record ? Date.parse(run.record.startedAt) : NaN;
  return Number.isNaN(t) ? folderStamp(run.stamp) : stamp(new Date(t));
}

// The steps of a run for display. When the run is not live, a step that never
// got an end (cancelled, cut off) is shown as stopped at the end of the run.
export function settledSteps(run: RunItem, state: Pick<DataState, 'agents'>): StepRecord[] {
  const steps = run.record?.steps ?? [];
  if (isLive(run, state)) return steps;
  return steps.map((s) => (s.endedAt ? s : { ...s, endedAt: run.record?.endedAt ?? s.startedAt, result: 'stopped' }));
}

// Which glyph and colour a step gets. Plain checks (SHIP, SKIP, done) pass.
export function stepMark(step: StepRecord): { glyph: string; colour: string } {
  if (!step.endedAt) return { glyph: '◐', colour: theme.accent };
  const r = (step.result ?? '').toUpperCase();
  if (r === 'FIX') return { glyph: '↻', colour: theme.yellow };
  if (r === 'BLOCKED' || r === 'FAILED') return { glyph: '✗', colour: theme.red };
  if (r === 'STOPPED') return { glyph: '-', colour: theme.dim };
  return { glyph: '✓', colour: theme.green };
}

export const stepResult = (step: StepRecord): string => (step.endedAt ? (step.result ?? 'done').toLowerCase() : '...');

export function stepMs(step: StepRecord, nowMs: number): number | null {
  const start = Date.parse(step.startedAt);
  if (Number.isNaN(start)) return null;
  const end = step.endedAt ? Date.parse(step.endedAt) : nowMs;
  return Math.max(0, end - start);
}

export const stepDuration = (step: StepRecord, nowMs: number): string => {
  const ms = stepMs(step, nowMs);
  return ms === null ? '' : duration(ms);
};

// One line per step: mark, name, result, time, tokens and cost, summary.
export function stepLine(step: StepRecord, nowMs: number): Line {
  const m = stepMark(step);
  const used = usageText(step.usage);
  return [
    seg(`${m.glyph} `, m.colour),
    seg(step.label.padEnd(8)),
    seg(stepResult(step).padEnd(7), step.endedAt ? undefined : theme.dim),
    seg(stepDuration(step, nowMs).padStart(4) + '  ', theme.dim),
    ...(used ? [seg(`${used}  `, theme.dim)] : []),
    seg(truncate(step.summary ?? '', 300), theme.dim),
  ];
}

// Window of `size` rows that keeps `selected` in view.
export function windowStart(total: number, selected: number, size: number, start: number): number {
  if (total <= size) return 0;
  let s = Math.min(start, total - size);
  if (selected < s) s = selected;
  if (selected >= s + size) s = selected - size + 1;
  return Math.max(0, s);
}

export interface RunsKeys {
  action: 'open' | 'cancel' | 'retry' | 'from' | 'clean' | 'filter' | 'up' | 'down' | null;
}

export function runsKey(input: string, key: Partial<Key>): RunsKeys['action'] {
  if (key.return) return 'open';
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (input === 'c') return 'cancel';
  if (input === 'r') return 'retry';
  if (input === 'f') return 'from';
  if (input === 'x') return 'clean';
  if (input === '/') return 'filter';
  return null;
}

// The confirm text from the approved mockup.
export function cancelSpec(card: string, stepLabel?: string): ActionSpec {
  return {
    args: ['agents', 'cancel', card],
    title: `Cancel ${card}?`,
    body: `Stops the ${stepLabel || 'running'} agent now. The card loses its VoidShift labels and gets a comment; add vs-plan again to restart it.`,
    confirmLabel: 'Cancel card',
    cancelLabel: 'Keep running',
    done: `${card} cancelled`,
  };
}

export const RUN_HINTS: Hint[] = [
  { key: 'enter', label: 'open' },
  { key: 'c', label: 'cancel' },
  { key: 'r', label: 'retry' },
  { key: 'f', label: 'run from step' },
  { key: 'x', label: 'clean old' },
  { key: '/', label: 'filter' },
  { key: 'esc', label: 'back' },
];

// The step to open the log on: the running one, else the last that ran.
export function logStepOf(run: RunItem): StepRecord | undefined {
  const steps = run.record?.steps ?? [];
  return [...steps].reverse().find((s) => !s.endedAt) ?? steps[steps.length - 1];
}

// ---- labels from `vsf agents show CARD --json` -------------------------------

const labelCache = new Map<string, { at: number; labels: string[] | null }>();
const LABELS_TTL_MS = 60_000;

export async function fetchLabelsReal(card: string): Promise<string[] | null> {
  const r = await runAction(['agents', 'show', card, '--json'], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  try {
    const labels = (JSON.parse(r.output) as { labels?: unknown }).labels;
    return Array.isArray(labels) ? labels.map(String) : null;
  } catch {
    return null;
  }
}

// Swapped out in tests.
export const runsDeps = { fetchLabels: fetchLabelsReal, debounceMs: 500 };

export function useLabels(card: string | undefined): string[] | null {
  const [labels, setLabels] = useState<string[] | null>(card ? (labelCache.get(card)?.labels ?? null) : null);
  useEffect(() => {
    if (!card || process.env.VSF_TUI_NO_LABELS === '1') {
      setLabels(null);
      return;
    }
    const hit = labelCache.get(card);
    setLabels(hit?.labels ?? null);
    if (hit && Date.now() - hit.at < LABELS_TTL_MS) return;
    let live = true;
    const t = setTimeout(() => {
      runsDeps.fetchLabels(card).then(
        (l) => {
          labelCache.set(card, { at: Date.now(), labels: l });
          if (live) setLabels(l);
        },
        () => {},
      );
    }, runsDeps.debounceMs);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [card]);
  return labels;
}

// ---- the component ---------------------------------------------------------

type Mode = 'list' | 'filter' | 'pick';

export function Runs(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const { state } = useData();
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<Mode>('list');
  const [filter, setFilter] = useState('');
  const [selDir, setSelDir] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const start = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const wanted = typeof props.params.card === 'string' ? props.params.card : null;
  const job = typeof props.params.job === 'string' ? props.params.job : null;
  const runs = useMemo(() => filterRuns(listRuns(state.runs, job), filter), [state.runs, job, filter]);
  let index = selDir ? runs.findIndex((r) => r.dir === selDir) : -1;
  if (index < 0 && !selDir && wanted) index = runs.findIndex((r) => r.card === wanted);
  if (index < 0) index = 0;
  const run: RunItem | undefined = runs[index];
  const record = run?.record;
  const isLatest = !!run && state.runs.find((r) => r.card === run.card)?.dir === run.dir;
  const labels = useLabels(isLatest && record ? run!.card : undefined);
  const live = isLive(run, state);
  const liveStep = liveRunFor(run, state)?.step;

  const workflow = state.workflows.find((w) => w.name === record?.workflow);
  const stepIds = workflow?.steps ?? [...new Set((record?.steps ?? []).map((s) => s.step))];
  const labelOf = (id: string) => state.steps?.steps.find((s) => s.id === id)?.label ?? record?.steps.find((s) => s.step === id)?.label ?? id;
  const options = stepIds.map((id) => ({ value: id, label: labelOf(id) }));

  useEquivalent(mode === 'pick' && run && from ? ['agents', 'run', run.card, '--from', from] : null);
  useEffect(() => {
    tabLock.on = mode === 'pick';
    return () => {
      tabLock.on = false;
    };
  }, [mode]);
  useHints(
    mode === 'filter'
      ? [
          { key: 'enter', label: 'apply' },
          { key: 'esc', label: 'clear' },
        ]
      : mode === 'pick'
        ? [
            { key: '←→', label: 'choose step' },
            { key: 'enter', label: 'list' },
            { key: 'g', label: 'run' },
            { key: 'esc', label: 'cancel' },
          ]
        : filter
          ? [...RUN_HINTS.slice(0, -1), { key: 'esc', label: 'clear filter' }]
          : RUN_HINTS,
  );
  useBackGuard(() => {
    if (mode === 'pick') {
      setMode('list');
      return true;
    }
    if (filter) {
      setFilter('');
      return true;
    }
    return false;
  });

  const move = (delta: number) => {
    const next = runs[Math.max(0, Math.min(runs.length - 1, index + delta))];
    if (next) setSelDir(next.dir);
  };

  useKeys((input, key) => {
    if (mode === 'filter') {
      if (key.escape) {
        setFilter('');
        setMode('list');
      }
      return;
    }
    if (mode === 'pick') {
      if (!ctx.capturing && input === 'g' && run && from) {
        const label = labelOf(from);
        setMode('list');
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
    const action = runsKey(input, key);
    if (action === 'up') move(-1);
    else if (action === 'down') move(1);
    else if (action === 'filter') setMode('filter');
    else if (action === 'clean')
      void ctx.actions.run({
        args: ['agents', 'clean', '--yes'],
        title: 'Clean old runs?',
        body: 'Removes run folders and worktrees older than 14 days. Work in progress is kept.',
        confirmLabel: 'Clean',
        cancelLabel: 'Keep them',
      });
    else if (!run) return;
    else if (action === 'open') {
      const step = logStepOf(run);
      ctx.nav.push('agents.card', { ...(job ? { job } : { card: run.card }), dir: run.dir, ...(step ? { step: step.step } : {}) });
    } else if (action === 'cancel') {
      if (!live) ctx.toast(`${run.card} is not running, so there is nothing to cancel.`, 'info');
      else void ctx.actions.run(cancelSpec(run.card, liveStep));
    } else if (action === 'retry') {
      if (record?.source === 'cron') ctx.toast('Scheduled runs are not retried. The job runs again on its schedule.', 'info');
      else
        void ctx.actions.run({
          args: ['agents', 'retry', run.card],
          title: `Retry ${run.card}?`,
          body: `Queues ${run.card} again. The runner picks it up on its next check.`,
          confirmLabel: 'Retry card',
          cancelLabel: 'Cancel',
          done: `${run.card} queued again`,
        });
    } else if (action === 'from') {
      if (live) ctx.toast(`${run.card} is running. Cancel it first.`, 'info');
      else if (!options.length) ctx.toast('No steps known for this run.', 'info');
      else {
        const last = record?.steps[record.steps.length - 1]?.step;
        setFrom(last && stepIds.includes(last) ? last : stepIds[0]!);
        setMode('pick');
      }
    }
  }, { whileCapturing: true });

  // ---- layout ----
  const steps = (run ? settledSteps(run, state) : []).slice(-8);
  const attempts = run && record?.source !== 'cron' ? attemptsOf(state.runs, run.card) : [];
  const at = attempts.findIndex((r) => r.dir === run?.dir);
  const attemptNo = attempts.length - Math.max(0, at);
  const earlier = attempts.slice(Math.max(0, at) + 1, Math.max(0, at) + 4);
  const detailRows = Math.max(2, steps.length) + 2 + (attempts.length > 1 ? 1 + earlier.length : 0) + (record?.outcome === 'parked' || record?.outcome === 'failed' || record?.outcome === 'running' ? 1 : 0) + (mode === 'pick' ? 2 : 0);
  const listSize = Math.max(3, ctx.rows - 5 - 3 - (detailRows + 2));
  start.current = windowStart(runs.length, index, listSize, start.current);
  const shown = runs.slice(start.current, start.current + listSize);
  const wide = ctx.columns >= 96;
  const maxRoundsOf = (r: RunItem) => state.workflows.find((w) => w.name === r.record?.workflow)?.maxRounds ?? 0;
  const roundsText = (r: RunItem) => (maxRoundsOf(r) > 1 ? `${roundsOf(r.record?.steps ?? [])}/${maxRoundsOf(r)}` : '');
  const showRounds = shown.some((r) => roundsText(r) !== '');
  const cardWidth = Math.max(8, Math.min(18, Math.max(0, ...shown.map((r) => r.card.length)) + 2));
  const rows: Cell[][] = shown.map((r) => {
    const outcome = outcomeOf(r, state);
    const ms = runMs(r, now, isLive(r, state));
    return [
      { text: r.card, bold: true },
      startedText(r),
      r.record?.workflow ?? '',
      stepsLabel(r.record?.steps ?? []),
      { text: outcome, colour: outcomeColour(outcome) },
      ...(showRounds ? [roundsText(r)] : []),
      ms === null ? '' : duration(ms),
    ];
  });
  const cols = [
    { title: 'CARD', width: cardWidth },
    { title: 'STARTED', width: 14 },
    { title: 'WORKFLOW', width: wide ? 20 : 14 },
    { title: 'STEPS', width: wide ? 14 : 12 },
    { title: 'OUTCOME', width: 12 },
    ...(showRounds ? [{ title: 'ROUNDS', width: 8 }] : []),
    { title: 'TIME' },
  ];
  const empty = !state.loaded ? 'Loading...' : filter ? `No runs match "${filter}".` : 'No runs yet. They appear here when a card is picked up.';
  const title = filter && mode !== 'filter' ? `Runs matching "${filter}"` : job ? `${job} runs, newest first` : 'Runs, newest first';

  const detail: Line[] = steps.map((s) => stepLine(s, now));
  if (record && !steps.length) detail.push([seg('No steps yet.', theme.dim)]);
  const shownAs = run ? outcomeOf(run, state) : '';
  const why = shownAs === 'failed' ? (record?.reason ?? 'The run stopped without finishing.') : record?.reason;
  if ((shownAs === 'parked' || shownAs === 'failed') && why) detail.push([seg(shownAs === 'failed' ? 'Failed: ' : 'Parked: ', shownAs === 'failed' ? theme.red : theme.yellow), seg(truncate(why, 300))]);
  if (attempts.length > 1) {
    detail.push([seg(`Attempt ${attemptNo} of ${attempts.length}`, theme.dim)]);
    for (const a of earlier) {
      const ms = runMs(a, now, isLive(a, state));
      detail.push([seg(`${startedText(a)}  ${outcomeOf(a, state)}  ${ms === null ? '' : duration(ms)}`, theme.dim)]);
    }
  }
  if (record) {
    detail.push([]);
    const tail: Line = [];
    if (record.prUrl) tail.push(seg('PR ', theme.dim), seg(record.prUrl.replace(/^https?:\/\//, ''), theme.accent), seg('   '));
    if (labels) tail.push(seg('labels ', theme.dim), seg(labels.join(' ') || 'none'));
    detail.push(tail);
  } else if (run) detail.push([seg('This run has logs only. Enter opens it.', theme.dim)]);

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Panel,
      { title, focused: mode !== 'pick', subtitle: mode === 'filter' ? undefined : runs.length > shown.length ? `${index + 1} of ${runs.length}` : undefined },
      mode === 'filter'
        ? h(Box, null, h(Text, { color: theme.dim }, 'Filter by card or workflow: '), h(TextInput, { value: filter, onChange: setFilter, onSubmit: () => setMode('list'), placeholder: 'ENG-12 or tether' }))
        : null,
      h(Table, { columns: cols, rows, selected: index - start.current, empty }),
    ),
    run
      ? h(
          Panel,
          { title: `${run.card}${record?.title ? '  ' + truncate(record.title, Math.max(10, ctx.columns - 20)) : ''}`, focused: mode === 'pick' },
          h(Lines, { lines: detail }),
          mode === 'pick'
            ? h(
                Box,
                { marginTop: 1 },
                h(Text, { color: theme.dim }, `Run ${run.card} from: `),
                h(Select, { options, value: from, onChange: setFrom }),
              )
            : null,
        )
      : null,
  );
}

export const runsScreen: Screen = {
  id: 'agents.runs',
  title: 'Runs',
  component: Runs,
  hints: () => RUN_HINTS,
};
