// The dashboard's store. While the dashboard is open it polls every 2 seconds:
// each added tool's `status --json` (and for agents also runs, workflows,
// projects and homes), runs the doctor-style checks every 30 seconds, and asks
// npm once for a newer vsf. Everything is read in-process with a capturing
// ctx.log, so nothing ever prints to the real stdout while Ink is mounted.
// A failing source becomes a string in `errors[source]`; it never throws.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { execFile } from 'node:child_process';
import { baseChecks, run } from '../checks.ts';
import { configDir, context, readConfig } from '../config.ts';
import { locate } from '../loader.ts';
import { findTool } from '../registry.ts';
import type { Check, Tool, ToolContext } from '../tool.ts';
import { CLI_PKG, cliVersion, isNewer } from '../version.ts';

const h = React.createElement;

export const POLL_MS = 2000;
export const CHECKS_MS = 30_000;

// ---- shapes of the JSON the tools print ----------------------------------

export interface AgentsCurrent {
  pid: number;
  card?: string;
  title?: string;
  workflow?: string;
  step?: string;
  round?: number;
  startedAt?: string;
  runDir?: string;
  checking?: boolean;
  elapsedMinutes?: number;
  workspace?: string;
}

export interface AgentsStatus {
  engine?: string;
  runner: 'running' | 'paused' | 'stopped';
  lastTick: { at: string; line: string } | null;
  // The first live run, or the runner checking for work.
  current: AgentsCurrent | null;
  // Every live run, one per busy workspace. Older agents print only current.
  running?: AgentsCurrent[];
  parked: { card: string; reason?: string }[];
  interrupted: string[];
  workflows: number;
  projects: number;
  // The Claude 5 hour window as last read; older agents print none.
  window?: AgentsWindow | null;
  // Most runs at once; 0 or unset means no cap.
  maxRuns?: number;
}

export interface AgentsWindow {
  checkedAt: string;
  // Percent used, 0 to 100.
  utilization?: number;
  resetsAt?: string;
  error?: string;
  // Set while no new run starts: when the window resets.
  heldUntil?: string | null;
}

// Tokens and cost of a step, or of a whole run.
export interface Usage {
  input?: number;
  output?: number;
  cached?: number;
  costUsd?: number;
  model?: string;
  models?: string[];
}

// The runs going on now, whichever shape the agents tool printed.
export const liveRunsOf = (agents: AgentsStatus | null | undefined): AgentsCurrent[] =>
  agents?.running ?? (agents?.current?.card ? [agents.current] : []);

export interface StepRecord {
  step: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  result?: string;
  summary?: string;
  log?: string;
  usage?: Usage;
}

export interface RunRecord {
  card: string;
  title: string;
  url?: string;
  workflow: string;
  trigger?: string;
  steps: StepRecord[];
  outcome: 'running' | 'verified' | 'changes' | 'parked' | 'cancelled';
  reason?: string;
  prUrl?: string;
  startedAt: string;
  endedAt?: string;
  usage?: Usage;
}

export interface RunItem {
  card: string;
  stamp: string;
  dir: string;
  logs: string[];
  record?: RunRecord;
}

export interface WorkflowItem {
  name: string;
  triggers: { source: string; team?: string; label?: string; schedule?: string; task?: string }[];
  steps: string[];
  maxRounds: number;
  project: string;
}

export interface ProjectItem {
  name: string;
  path: string;
  base?: string;
  usedBy?: string[];
}

export interface HomeItem {
  [key: string]: unknown;
}

export interface AwakeStatus {
  on: boolean;
  sleepDisabledByOther: boolean;
  since: string | null;
  until: string | null;
  minutesLeft: number | null;
  batteryFloor: number;
  floorApplies: boolean;
  power: { onBattery: boolean; percent: number | null };
  watchdog: boolean;
  lastReason: string | null;
}

export interface MemoryStatus {
  vault: string;
  isVault: boolean;
  notes: number;
  indexed: number;
  unindexed: { count: number; names: string[] };
  lastUpdated: string | null;
  homes: { kind: 'claude' | 'codex'; dir: string; recall: string; skill: string }[];
}

// From the hidden `vsf agents steps` command: what the workflow forms offer.
export interface StepsCatalog {
  steps: { id: string; name: string; label: string; hint: string; output: string }[];
  templates: Record<string, { steps: string[]; maxRounds: number }>;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  // False until the one check at start has answered (or timed out).
  checked: boolean;
}

export interface DataState {
  version: string;
  // Added tools, in config order. Hidden sections of the dashboard follow this.
  tools: string[];
  agents: AgentsStatus | null;
  awake: AwakeStatus | null;
  memory: MemoryStatus | null;
  runs: RunItem[];
  workflows: WorkflowItem[];
  projects: ProjectItem[];
  homes: HomeItem[];
  // The agents settings file, read in-process (timeoutMinutes and the like).
  agentsConfig: Record<string, unknown> | null;
  steps: StepsCatalog | null;
  checks: Check[] | null;
  checksAt: number | null;
  update: UpdateInfo;
  // One message per failed source: "agents", "awake", "memory", "checks", "agents.runs"...
  errors: Record<string, string>;
  // True once the first poll finished.
  loaded: boolean;
  // Epoch ms of the last finished poll.
  at: number;
}

export interface Data {
  state: DataState;
  // Poll again now (after an action).
  refresh(): void;
  // Run the checks again now.
  refreshChecks(): void;
  // A tool's saved settings, read on demand. Null when the tool has none.
  readConfig(tool: string): Record<string, unknown> | null;
  // A tool's help output, captured (for the command palette). Empty on failure.
  help(tool: string): Promise<string>;
}

export function emptyState(tools: string[] = []): DataState {
  return {
    version: cliVersion(),
    tools,
    agents: null,
    awake: null,
    memory: null,
    runs: [],
    workflows: [],
    projects: [],
    homes: [],
    agentsConfig: null,
    steps: null,
    checks: null,
    checksAt: null,
    update: { current: cliVersion(), latest: null, checked: false },
    errors: {},
    loaded: false,
    at: 0,
  };
}

// ---- pure helpers --------------------------------------------------------

// Runs a tool command with a capturing log and parses its JSON output.
export async function captureJson(tool: Pick<Tool, 'commands'>, command: string, args: string[], base: ToolContext): Promise<unknown> {
  const fn = tool.commands?.[command];
  if (!fn) throw new Error(`no ${command} command`);
  let out = '';
  const code = await fn(args, { ...base, log: (line) => (out += line + '\n') });
  if (code !== 0) throw new Error(out.trim().split('\n')[0] || `${command} exited ${code}`);
  return JSON.parse(out);
}

// Captures a tool command's text output (for the palette's command list).
export async function captureText(tool: Pick<Tool, 'commands'>, command: string, args: string[], base: ToolContext): Promise<string> {
  const fn = tool.commands?.[command];
  if (!fn) return '';
  let out = '';
  await fn(args, { ...base, log: (line) => (out += line + '\n') });
  return out;
}

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

// Runs of the last 7 days.
export function runsThisWeek(runs: RunItem[], nowMs: number): number {
  const since = nowMs - 7 * 24 * 3600 * 1000;
  return runs.filter((r) => {
    const t = Date.parse(r.record?.startedAt ?? '');
    return !Number.isNaN(t) && t >= since;
  }).length;
}

// The newer version to announce, or null.
export function updateNotice(update: UpdateInfo): string | null {
  return update.latest && isNewer(update.latest, update.current) ? update.latest : null;
}

// ---- the poller ----------------------------------------------------------

// Asks npm for the latest version. Resolves null on any failure or timeout.
function latestAsync(pkg: string, timeout: number): { result: Promise<string | null>; cancel(): void } {
  let child: ReturnType<typeof execFile> | undefined;
  const result = new Promise<string | null>((resolve) => {
    child = execFile('npm', ['view', '--prefer-online', pkg, 'version'], { timeout, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
  return { result, cancel: () => child?.kill() };
}

export class Poller {
  state: DataState = emptyState();
  private listeners = new Set<() => void>();
  private tools = new Map<string, Tool>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private again = false;
  private checking = false;
  private stopped = false;
  private lastChecks = 0;
  private base: ToolContext = context();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<DataState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  start(): void {
    void this.poll();
    void this.checkUpdate();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.cancelUpdate?.();
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
  }

  refresh = (): void => {
    void this.poll();
  };

  refreshChecks = (): void => {
    this.lastChecks = 0;
    void this.poll();
  };

  readToolConfig = (name: string): Record<string, unknown> | null => {
    const tool = this.tools.get(name);
    try {
      return tool?.config ? tool.config.read(this.base.configDir) : null;
    } catch {
      return null;
    }
  };

  helpText = async (name: string): Promise<string> => {
    try {
      return await captureText(await this.load(name), 'help', [], this.base);
    } catch {
      return '';
    }
  };

  private cancelUpdate: (() => void) | null = null;

  private async checkUpdate(): Promise<void> {
    const ask = latestAsync(CLI_PKG, 3000);
    this.cancelUpdate = ask.cancel;
    const latest = await ask.result;
    if (!this.stopped) this.set({ update: { current: cliVersion(), latest, checked: true } });
  }

  // Tools are loaded from disk only: loadTool would run npm to fetch a
  // missing one, and that must never block the screen.
  private async load(name: string): Promise<Tool> {
    const cached = this.tools.get(name);
    if (cached) return cached;
    const entry = findTool(name);
    if (!entry) throw new Error(`unknown tool ${name}`);
    const path = locate(entry, configDir());
    if (!path) throw new Error('not downloaded. Run vsf update');
    const { pathToFileURL } = await import('node:url');
    const mod = (await import(pathToFileURL(path).href)) as { default: Tool };
    this.tools.set(name, mod.default);
    return mod.default;
  }

  private async poll(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      let names: string[] = [];
      const errors: Record<string, string> = {};
      try {
        names = readConfig().tools.filter((n) => !!findTool(n));
      } catch (err) {
        errors.config = messageOf(err);
      }
      const patch: Partial<DataState> = { tools: names };

      await Promise.all(
        names.map(async (name) => {
          try {
            const tool = await this.load(name);
            const status = (await captureJson(tool, 'status', ['--json'], this.base)) as never;
            if (name === 'agents') patch.agents = status;
            if (name === 'awake') patch.awake = status;
            if (name === 'memory') patch.memory = status;
            if (name === 'agents') await this.pollAgents(tool, patch, errors);
          } catch (err) {
            errors[name] = messageOf(err);
          }
        }),
      );
      if (!names.includes('agents')) Object.assign(patch, { agents: null, runs: [], workflows: [], projects: [], homes: [], agentsConfig: null });
      if (!names.includes('awake')) patch.awake = null;
      if (!names.includes('memory')) patch.memory = null;

      this.set({ ...patch, errors: { ...errors, ...this.keepCheckError() }, loaded: true, at: Date.now() });
      if (Date.now() - this.lastChecks >= CHECKS_MS) void this.runChecks(names);
    } finally {
      this.busy = false;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.poll();
      }
    }
  }

  private keepCheckError(): Record<string, string> {
    const e = this.state.errors.checks;
    return e ? { checks: e } : {};
  }

  private async pollAgents(tool: Tool, patch: Partial<DataState>, errors: Record<string, string>): Promise<void> {
    const get = async <T>(key: string, command: string, args: string[], into: (v: T) => void) => {
      try {
        into((await captureJson(tool, command, args, this.base)) as T);
      } catch (err) {
        errors[`agents.${key}`] = messageOf(err);
      }
    };
    await Promise.all([
      get<RunItem[]>('runs', 'runs', ['--json', '--limit', '60'], (v) => (patch.runs = v)),
      get<WorkflowItem[]>('workflows', 'workflows', ['--json'], (v) => (patch.workflows = v)),
      get<ProjectItem[]>('projects', 'projects', ['--json'], (v) => (patch.projects = v)),
      get<HomeItem[]>('homes', 'homes', ['--json'], (v) => (patch.homes = v)),
      // The step catalog never changes while the dashboard is open.
      this.state.steps ? Promise.resolve() : get<StepsCatalog>('steps', 'steps', [], (v) => (patch.steps = v)),
    ]);
    patch.agentsConfig = this.readToolConfig('agents');
  }

  // Doctor-style checks: base checks plus each added tool's own, in-process.
  private async runChecks(names: string[]): Promise<void> {
    if (this.checking || this.stopped) return;
    this.checking = true;
    this.lastChecks = Date.now();
    try {
      if (process.env.VSF_TUI_SKIP_CHECKS === '1') {
        this.set({ checks: [], checksAt: Date.now() });
        return;
      }
      const checks: Check[] = baseChecks(process.platform, process.version, run);
      for (const name of names) {
        try {
          const tool = await this.load(name);
          checks.push(...(await tool.checks({ ...this.base, log: () => {} })));
        } catch (err) {
          checks.push({ name, status: 'fail', detail: messageOf(err) });
        }
      }
      if (!this.stopped) {
        const { checks: _gone, ...errors } = this.state.errors;
        this.set({ checks, checksAt: Date.now(), errors });
      }
    } catch (err) {
      this.set({ errors: { ...this.state.errors, checks: messageOf(err) } });
    } finally {
      this.checking = false;
    }
  }
}

// ---- React glue ----------------------------------------------------------

export const DataContext = createContext<Data | null>(null);

export function useData(): Data {
  const data = useContext(DataContext);
  if (!data) throw new Error('useData needs a DataProvider');
  return data;
}

export function DataProvider(props: { poller?: Poller; children?: React.ReactNode }): React.ReactElement {
  const ref = useRef<Poller | null>(null);
  if (!ref.current) ref.current = props.poller ?? new Poller();
  const poller = ref.current;
  const [state, setState] = useState(poller.state);
  useEffect(() => {
    const off = poller.subscribe(() => setState(poller.state));
    poller.start();
    return () => {
      off();
      poller.stop();
    };
  }, [poller]);
  const value: Data = { state, refresh: poller.refresh, refreshChecks: poller.refreshChecks, readConfig: poller.readToolConfig, help: poller.helpText };
  return h(DataContext.Provider, { value }, props.children);
}
