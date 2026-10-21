// The Home screen: one live overview of every added tool. Tab moves between
// sections, Enter opens the focused one. The functions at the top are pure
// shaping of the store's data into lines (tested); the component below draws them.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useData, runsThisWeek, updateNotice, type AgentsStatus, type AwakeStatus, type DataState, type MemoryStatus, type RunItem } from './data.ts';
import { useHints, useKeys, useScreen, type Hint } from './context.ts';
import { clock, clockOrStamp, duration, minutesText, plural, secondsToNextCheck, tilde, truncate } from './format.ts';
import { theme } from './theme.ts';
import { Lines, Panel, ProgressSteps, seg, SplitRow, type Line, type StepProgress } from './widgets.ts';
import type { Check } from '../tool.ts';
import type { Screen } from './screens.ts';

const h = React.createElement;

// ---- sections and focus --------------------------------------------------

export type SectionId = 'agents' | 'awake' | 'memory' | 'checks';

// Sections of tools that are not added are hidden; Checks is always there.
export function sectionsFor(tools: string[]): SectionId[] {
  const out: SectionId[] = [];
  for (const t of ['agents', 'awake', 'memory'] as const) if (tools.includes(t)) out.push(t);
  out.push('checks');
  return out;
}

// Tab moves to the next section, Shift+Tab to the one before; both wrap.
export function nextSection(sections: SectionId[], current: SectionId, dir: 1 | -1): SectionId {
  const i = sections.indexOf(current);
  if (i === -1) return sections[0]!;
  return sections[(i + dir + sections.length) % sections.length]!;
}

// The focused section, or the first one when it just disappeared.
export const clampFocus = (sections: SectionId[], current: SectionId): SectionId => (sections.includes(current) ? current : sections[0]!);

// ---- Agents ---------------------------------------------------------------

export interface LiveCard {
  card: string;
  title: string;
  workflow: string;
  step: string;
  minutes: number;
  round: number;
  maxRounds: number | null;
  steps: StepProgress[];
}

const titleCase = (id: string) => {
  const t = id.replace(/^vs-/, '').replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// The card being worked on, with the progress of each step of its workflow.
export function liveCard(state: Pick<DataState, 'agents' | 'runs' | 'workflows' | 'steps' | 'agentsConfig'>, nowMs: number): LiveCard | null {
  const current = state.agents?.current;
  if (!current || !current.card) return null;
  const run: RunItem | undefined = state.runs.find(
    (r) => r.card === current.card && r.record?.outcome === 'running' && (!current.runDir || r.dir === current.runDir),
  );
  const rec = run?.record;
  const workflow = state.workflows.find((w) => w.name === (current.workflow ?? rec?.workflow));
  const recSteps = rec?.steps ?? [];
  const labelOf = (id: string) => state.steps?.steps.find((s) => s.id === id)?.label ?? recSteps.find((s) => s.step === id)?.label ?? titleCase(id);
  const ids = workflow?.steps ?? recSteps.map((s) => s.step).filter((s, i, all) => all.indexOf(s) === i);

  const runningRec = [...recSteps].reverse().find((s) => !s.endedAt);
  const byLabel = ids.find((id) => labelOf(id) === current.step);
  const runningId = runningRec?.step ?? byLabel;
  const runningPos = runningRec ? recSteps.indexOf(runningRec) : recSteps.length;
  const timeout = typeof state.agentsConfig?.timeoutMinutes === 'number' ? state.agentsConfig.timeoutMinutes : 45;

  const steps: StepProgress[] = ids.map((id) => {
    const label = labelOf(id);
    if (id === runningId) {
      const started = Date.parse(runningRec?.startedAt ?? current.startedAt ?? '');
      const min = Number.isNaN(started) ? 0 : (nowMs - started) / 60_000;
      return { label, state: 'running', fraction: Math.max(0.25, Math.min(0.9, min / timeout)) };
    }
    let last = -1;
    recSteps.forEach((s, i) => {
      if (s.step === id) last = i;
    });
    const done = last >= 0 && last < runningPos && !!recSteps[last]!.endedAt;
    if (!done) return { label, state: 'pending' };
    return { label, state: recSteps[last]!.result === 'FIX' ? 'failed' : 'done' };
  });

  const startedAt = Date.parse(current.startedAt ?? rec?.startedAt ?? '');
  return {
    card: current.card,
    title: current.title ?? rec?.title ?? '',
    workflow: current.workflow ?? rec?.workflow ?? '',
    step: current.step ?? '',
    minutes: current.elapsedMinutes ?? (Number.isNaN(startedAt) ? 0 : Math.max(0, Math.round((nowMs - startedAt) / 60_000))),
    round: (current.round ?? 0) + 1,
    maxRounds: workflow?.maxRounds ?? null,
    steps,
  };
}

// "● Runner running" and "last check 14:03 · next in 41s".
export function runnerLines(agents: AgentsStatus, nowMs: number): { left: Line; right: Line } {
  const left: Line =
    agents.runner === 'running'
      ? [seg('● ', theme.green), seg('Runner running')]
      : agents.runner === 'paused'
        ? [seg('● ', theme.yellow), seg('Runner paused'), seg('  p resumes it', theme.dim)]
        : [seg('○ ', theme.dim), seg('Runner stopped'), seg('  vsf agents start', theme.dim)];
  const right: Line = [];
  if (agents.lastTick) {
    const next = agents.runner === 'running' ? secondsToNextCheck(agents.lastTick.at, nowMs) : null;
    const parts = [`last check ${clock(new Date(agents.lastTick.at))}`];
    if (next !== null) parts.push(next > 0 ? `next in ${next}s` : 'due now');
    right.push(seg(parts.join(' · '), theme.dim));
  }
  return { left, right };
}

export interface ParkedRow {
  card: string;
  kind: 'parked' | 'interrupted';
  text: string;
}

// Parked and interrupted cards, the ones `r` can retry.
export function parkedRows(agents: AgentsStatus): ParkedRow[] {
  return [
    ...agents.parked.map((p) => ({ card: p.card, kind: 'parked' as const, text: p.reason ? `parked: ${truncate(p.reason, 70)}` : 'parked' })),
    ...agents.interrupted.map((c) => ({ card: c, kind: 'interrupted' as const, text: 'interrupted' })),
  ];
}

export function countsLine(agents: AgentsStatus, runs: RunItem[], nowMs: number): string {
  return [plural(agents.workflows, 'workflow'), plural(agents.projects, 'project'), plural(runsThisWeek(runs, nowMs), 'run') + ' this week'].join(' · ');
}

// ---- Awake ----------------------------------------------------------------

export function awakeLines(a: AwakeStatus): Line[] {
  const power = a.power.onBattery ? `on battery, ${a.power.percent ?? '?'}%` : 'on power adapter';
  const dog: Seg2 = a.watchdog ? seg('watchdog ok', theme.dim) : seg('watchdog not loaded', theme.yellow);
  if (a.on) {
    const stops = a.until && a.minutesLeft !== null ? `stops ${clock(new Date(a.until))} (${minutesText(a.minutesLeft)}) or at ${a.batteryFloor}%` : `stops at ${a.batteryFloor}%`;
    return [
      [seg('● ', theme.green), seg(`On since ${a.since ? clock(new Date(a.since)) : '?'}, the lid can close`)],
      [seg(`  ${stops}`)],
      [seg(`  ${power} · `, theme.dim), dog],
    ];
  }
  if (a.sleepDisabledByOther) {
    return [[seg('● ', theme.yellow), seg('Sleep is off, but not by VoidShift')], [seg(`  ${power}`, theme.dim)]];
  }
  const lines: Line[] = [[seg('○ ', theme.dim), seg('Off. The Mac sleeps normally.')]];
  if (a.lastReason) lines.push([seg(`  last session ended because ${a.lastReason}`, theme.dim)]);
  lines.push([seg(`  ${power} · `, theme.dim), dog]);
  return lines;
}
type Seg2 = ReturnType<typeof seg>;

// ---- Memory ---------------------------------------------------------------

const kindLabel = (k: string) => (k === 'codex' ? 'Codex' : 'Claude Code');

export function memoryLines(m: MemoryStatus, now: Date = new Date()): Line[] {
  if (!m.isVault) return [[seg('Vault has no INDEX.md', theme.yellow)], [seg(tilde(m.vault), theme.dim)]];
  const first: Line = [seg(plural(m.notes, 'note'))];
  if (m.unindexed.count) first.push(seg(' · '), seg(`${m.unindexed.count} not in INDEX.md`, theme.yellow));
  const lines: Line[] = [first];
  for (const home of m.homes.slice(0, 2)) {
    const recall = home.recall === 'on' ? 'recall on' : home.recall === 'other' ? 'another hook recalls' : 'recall off';
    lines.push([seg(`${recall} in ${kindLabel(home.kind)} `), seg(tilde(home.dir), theme.dim)]);
  }
  if (m.lastUpdated) lines.push([seg(`last note ${clockOrStamp(new Date(m.lastUpdated), now)}`, theme.dim)]);
  return lines;
}

// ---- Checks ---------------------------------------------------------------

export interface ChecksView {
  ok: number;
  warn: number;
  fail: number;
  problems: Check[];
}

export function checksView(checks: Check[]): ChecksView {
  const problems = checks.filter((c) => c.status !== 'ok');
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    problems: [...problems.filter((c) => c.status === 'fail'), ...problems.filter((c) => c.status === 'warn')],
  };
}

export function checksLines(checks: Check[]): { left: Line; right: Line }[] {
  const v = checksView(checks);
  const counts: Line = [seg(`✓ ${v.ok} ok`, theme.green)];
  if (v.warn) counts.push(seg('   '), seg(`! ${plural(v.warn, 'warning')}`, theme.yellow));
  if (v.fail) counts.push(seg('   '), seg(`✗ ${v.fail} failed`, theme.red));
  const detail = (c: Check): Line => [seg(`${c.name} ${c.detail}`), ...(c.fix ? [seg(`  fix: ${c.fix}`, theme.dim)] : [])];
  const rows: { left: Line; right: Line }[] = [];
  const [first, ...rest] = v.problems;
  rows.push({ left: first ? [...counts, seg('  '), ...detail(first)] : counts, right: first ? [seg('enter fixes it', theme.dim)] : [] });
  for (const c of rest.slice(0, 2)) rows.push({ left: [seg(c.status === 'fail' ? '✗ ' : '! ', c.status === 'fail' ? theme.red : theme.yellow), ...detail(c)], right: [] });
  if (rest.length > 2) rows.push({ left: [seg(`+${rest.length - 2} more`, theme.dim)], right: [] });
  return rows;
}

// ---- hints ----------------------------------------------------------------

export function homeHints(opts: { runner?: AgentsStatus['runner']; hasAwake: boolean }): Hint[] {
  const hints: Hint[] = [
    { key: 'tab', label: 'section' },
    { key: 'enter', label: 'open' },
  ];
  if (opts.runner) hints.push({ key: 'p', label: opts.runner === 'paused' ? 'resume runner' : 'pause runner' });
  if (opts.hasAwake) hints.push({ key: 'a', label: 'awake' });
  hints.push({ key: ':', label: 'command' }, { key: '?', label: 'keys' }, { key: 'q', label: 'quit' });
  return hints;
}

// ---- component ------------------------------------------------------------

export const homeScreen: Screen = {
  id: 'home',
  title: 'VoidShift',
  component: () => h(Home),
  hints: () => [{ key: 'q', label: 'quit' }],
};

const SCREEN_OF: Record<SectionId, string> = { agents: 'agents', awake: 'awake', memory: 'memory', checks: 'checks' };

export function Home(): React.ReactElement {
  const ctx = useScreen();
  const { state, refreshChecks } = useData();
  const sections = sectionsFor(state.tools);
  const [focus, setFocus] = useState<SectionId>('agents');
  const [parkedIdx, setParkedIdx] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const at = clampFocus(sections, focus);
  const agents = state.agents;
  const parked = agents ? parkedRows(agents) : [];
  const sel = Math.min(parkedIdx, Math.max(0, parked.length - 1));
  const update = updateNotice(state.update);

  useHints(homeHints({ runner: agents?.runner, hasAwake: !!state.awake }));

  useKeys((input, key) => {
    if (key.tab) setFocus(nextSection(sections, at, key.shift ? -1 : 1));
    else if (key.return) {
      const card = at === 'agents' ? parked[sel]?.card : undefined;
      ctx.nav.push(SCREEN_OF[at], at === 'agents' ? { tab: 'agents.runs', ...(card ? { card } : {}) } : {});
    } else if (at === 'agents' && key.upArrow) setParkedIdx(Math.max(0, sel - 1));
    else if (at === 'agents' && key.downArrow) setParkedIdx(Math.min(parked.length - 1, sel + 1));
    else if (input === 'p' && agents) {
      if (agents.runner === 'stopped') ctx.toast('The runner is stopped. Start it with: vsf agents start', 'info');
      else
        void ctx.actions.run({
          args: ['agents', agents.runner === 'paused' ? 'resume' : 'pause'],
          title: 'Pause the runner?',
          noConfirm: true,
          done: agents.runner === 'paused' ? 'Runner resumed' : 'Runner paused. A card in progress carries on.',
        });
    } else if (input === 'a' && state.awake) {
      if (state.awake.on) void ctx.actions.run({ args: ['awake', 'off'], title: 'Turn awake off?', noConfirm: true, done: 'Awake is off. The Mac sleeps normally.' });
      else
        void ctx.actions.run({
          args: ['awake', 'on'],
          title: 'Keep this Mac awake?',
          body: `The lid can close and the Mac keeps running. It stays on until the battery drops to ${state.awake.batteryFloor}% or you run "vsf awake off".`,
          confirmLabel: 'Turn on',
          cancelLabel: 'Cancel',
          done: 'Awake is on',
        });
    } else if (input === 'r' && parked[sel]) {
      const card = parked[sel]!.card;
      void ctx.actions.run({
        args: ['agents', 'retry', card],
        title: `Retry ${card}?`,
        body: `Queues ${card} again. The runner picks it up on its next check.`,
        confirmLabel: 'Retry card',
        cancelLabel: 'Cancel',
        done: `${card} queued again`,
      });
    } else if (input === 'u') {
      void ctx.actions.run({
        args: ['update'],
        title: 'Update VoidShift?',
        body: `Updates vsf${update ? ` to ${update}` : ''} and every tool you added. This can take a minute. Start vsf again afterwards to use it.`,
        confirmLabel: 'Update',
        cancelLabel: 'Cancel',
        timeoutMs: 10 * 60_000,
        done: 'Update finished. Start vsf again to use it.',
      });
    } else if (input === 'c') refreshChecks();
  });

  const panels: React.ReactNode[] = [];
  if (sections.includes('agents')) panels.push(h(AgentsPanel, { key: 'agents', focused: at === 'agents', selected: sel, now }));
  const lower: React.ReactNode[] = [];
  // Whole-number widths: halves of an odd width would misalign the borders.
  const count = ['awake', 'memory'].filter((t) => state.tools.includes(t)).length;
  const gap = count === 2 ? 1 : 0;
  const left = count === 2 ? Math.floor((ctx.columns - gap) / 2) : ctx.columns;
  if (state.tools.includes('awake'))
    lower.push(
      h(
        Panel,
        { key: 'awake', title: 'Awake', focused: at === 'awake', width: left },
        state.awake ? h(Lines, { lines: awakeLines(state.awake) }) : toolState(state.errors.awake),
      ),
    );
  if (state.tools.includes('memory'))
    lower.push(
      h(
        Box,
        { key: 'memory', marginLeft: lower.length ? gap : 0 },
        h(
          Panel,
          { title: 'Memory', focused: at === 'memory', width: lower.length ? ctx.columns - gap - left : ctx.columns },
          state.memory ? h(Lines, { lines: memoryLines(state.memory) }) : toolState(state.errors.memory),
        ),
      ),
    );
  if (lower.length) panels.push(h(Box, { key: 'lower', flexDirection: 'row' }, ...lower));
  panels.push(h(ChecksPanel, { key: 'checks', focused: at === 'checks' }));
  if (!state.tools.length && state.loaded) panels.unshift(h(Text, { key: 'none', color: theme.dim }, ' No tools added yet. Run vsf setup in a terminal to pick some.'));
  return h(Box, { flexDirection: 'column' }, ...panels);
}

const toolState = (error: string | undefined) => h(Text, { color: error ? theme.yellow : theme.dim, wrap: 'truncate-end' }, error ?? 'Loading...');

function AgentsPanel(props: { focused: boolean; selected: number; now: number }): React.ReactElement {
  const { state } = useData();
  const agents = state.agents;
  if (!agents) return h(Panel, { title: 'Agents', focused: props.focused }, toolState(state.errors.agents));

  const run = runnerLines(agents, props.now);
  const live = liveCard(state, props.now);
  const parked = parkedRows(agents);
  const rows: React.ReactNode[] = [h(SplitRow, { key: 'runner', left: run.left, right: run.right })];

  if (live) {
    rows.push(h(Text, { key: 'g1' }, ' '));
    rows.push(
      h(SplitRow, {
        key: 'live',
        left: [seg('▶ ', theme.accent), seg(live.card, theme.accent, { bold: true }), seg(`  ${truncate(live.title, 60)}`)],
        right: [seg(live.workflow, theme.dim)],
      }),
    );
    rows.push(
      h(
        Box,
        { key: 'steps', flexDirection: 'row' },
        h(Text, null, '  '),
        h(ProgressSteps, { steps: live.steps }),
        h(
          Text,
          { color: theme.dim },
          `       running ${duration(live.minutes * 60_000)}${live.maxRounds ? ` · round ${live.round} of ${live.maxRounds}` : ` · round ${live.round}`}`,
        ),
      ),
    );
  } else if (agents.current) {
    rows.push(h(Text, { key: 'g1' }, ' '));
    rows.push(h(Text, { key: 'checking', color: theme.dim }, '  Checking Linear now.'));
  }

  if (parked.length) {
    rows.push(h(Text, { key: 'g2' }, ' '));
    parked.forEach((p, i) => {
      const on = props.focused && i === props.selected;
      rows.push(
        h(SplitRow, {
          key: `p${p.card}`,
          left: [seg(p.kind === 'parked' ? '! ' : '○ ', p.kind === 'parked' ? theme.yellow : theme.dim), seg(p.card, p.kind === 'parked' ? theme.yellow : theme.dim, { bold: on }), seg(`  ${p.text}`)],
          right: on || parked.length === 1 ? [seg('r retry · enter details', theme.dim)] : [],
        }),
      );
    });
  }
  rows.push(h(Text, { key: 'g3' }, ' '));
  rows.push(h(Text, { key: 'counts', color: theme.dim }, countsLine(agents, state.runs, props.now)));
  for (const key of ['agents.runs', 'agents']) {
    if (state.errors[key]) rows.push(h(Text, { key: `e${key}`, color: theme.yellow, wrap: 'truncate-end' }, `! ${state.errors[key]}`));
  }
  return h(Panel, { title: 'Agents', focused: props.focused }, ...rows);
}

function ChecksPanel(props: { focused: boolean }): React.ReactElement {
  const { state } = useData();
  if (state.checks && state.checks.length === 0 && process.env.VSF_TUI_SKIP_CHECKS === '1')
    return h(Panel, { title: 'Checks', focused: props.focused }, h(Text, { color: theme.dim }, 'Checks skipped'));
  if (!state.checks) return h(Panel, { title: 'Checks', focused: props.focused }, toolState(state.errors.checks ?? (state.checksAt === null ? 'Checking…' : undefined)));
  return h(
    Panel,
    { title: 'Checks', focused: props.focused },
    ...checksLines(state.checks).map((r, i) => h(SplitRow, { key: i, left: r.left, right: r.right })),
  );
}
