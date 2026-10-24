import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AGENTS, AGENT_FILE, DEFAULT_WORKSPACE, OUTPUTS, STEP_ID, WORKSPACE_NAME, isBuiltin, readAgentFolder, stepFile, type AgentsConfig, type Step, type StepDef, type StepId, type Trigger, type Workflow, describeTrigger, triggerSpec } from './config.ts';
import { parseCron } from './cron.ts';
import { LABELS } from './workflow.ts';

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// The line a step's prompt must ask for, so the runner can read the result.
const RESULT_LINE: Partial<Record<StepDef['output'], string>> = { plan: 'RESULT:', commits: 'RESULT:', verdict: 'VERDICT:' };

// Everything wrong with one step. `dir` is the agent folder its files are in.
export function validateStep(step: Step, config: Pick<AgentsConfig, 'enabled'> & Partial<Pick<AgentsConfig, 'workflows'>>, dir?: string): string[] {
  if (typeof step === 'string') {
    if (!isBuiltin(step)) return [`Unknown step ${step}.`];
    return config.enabled.length && !config.enabled.includes(step) ? [`Step ${step} is not enabled.`] : [];
  }
  if (!isObj(step)) return ['A step must be a step id or an object.'];
  const problems: string[] = [];
  const id = typeof step.id === 'string' && STEP_ID.test(step.id) ? step.id : null;
  if (!id) problems.push(`Step id ${String(step.id)} must be lowercase letters, digits and dashes.`);
  else if (isBuiltin(id)) problems.push(`Step id ${id} is a built-in step; use "${id}" on its own, or another id.`);
  const name = id ?? 'A step';
  if (!OUTPUTS.includes(step.output)) problems.push(`${name} output must be one of: ${OUTPUTS.join(', ')}.`);
  if (step.label !== undefined && typeof step.label !== 'string') problems.push(`${name} label must be text.`);
  if (step.prompt !== undefined && typeof step.prompt !== 'string') problems.push(`${name} prompt must be a file name.`);
  if (step.skill !== undefined && typeof step.skill !== 'string') problems.push(`${name} skill must be a name or a folder.`);
  if (step.run !== undefined && (typeof step.run !== 'string' || !step.run.trim())) problems.push(`${name} run must be a command.`);
  if (step.handoff !== undefined) {
    if (typeof step.handoff !== 'string' || !step.handoff.trim()) problems.push(`${name} handoff must be a workflow name.`);
    else if (config.workflows && !Object.hasOwn(config.workflows, step.handoff)) problems.push(`${name} hands cards to ${step.handoff}, which is not a workflow.`);
  }
  const sources = [step.skill, step.prompt, step.run].filter((v) => v !== undefined).length;
  if (step.output === 'publish') {
    if (sources) problems.push(`${name} only pushes the branch, so it takes no skill, prompt or run.`);
  } else if (sources !== 1) problems.push(`${name} needs exactly one of skill, prompt or run.`);
  else if (step.run !== undefined) {
    if (step.output !== 'none') problems.push(`${name} runs a command, so its output must be none.`);
  } else if (typeof (step.prompt ?? step.skill) === 'string') {
    const file = stepFile(step, dir);
    if (!file || !existsSync(file)) problems.push(`${name} ${step.prompt ? 'prompt' : 'skill'} ${file ?? ''} does not exist.`);
    else {
      const want = RESULT_LINE[step.output];
      if (want && !readFileSync(file, 'utf8').includes(want)) problems.push(`${name} prompt never asks for a ${want} line.`);
    }
  }
  if (step.engine !== undefined && step.engine !== 'claude' && step.engine !== 'codex') problems.push(`${name} engine must be claude or codex.`);
  if (step.model !== undefined && typeof step.model !== 'string') problems.push(`${name} model must be text.`);
  if (step.timeoutMinutes !== undefined && !isInt(step.timeoutMinutes, 1, 480)) problems.push(`${name} timeoutMinutes must be a whole number from 1 to 480.`);
  if (step.write !== undefined && typeof step.write !== 'boolean') problems.push(`${name} write must be true or false.`);
  else if (step.write === false && step.output === 'commits') problems.push(`${name} makes commits, so write cannot be false.`);
  return problems;
}

// Everything wrong with one workflow, in plain words. Empty means it is fine.
// `dir` is the agent folder a folder workflow comes from.
export function validateWorkflow(config: Pick<AgentsConfig, 'enabled' | 'projects'> & Partial<Pick<AgentsConfig, 'workflows'>>, workflow: Workflow, dir?: string): string[] {
  const problems: string[] = [];
  if (!workflow.triggers?.length) problems.push('Needs at least one trigger.');
  for (const t of workflow.triggers ?? []) {
    if (t.source === 'cron') {
      if (!parseCron(t.schedule ?? '')) problems.push(`Schedule ${t.schedule} is not a five field cron schedule, like 0 5 * * 1.`);
      if (!t.task?.trim()) problems.push('A schedule has no task.');
    } else if (t.source !== 'linear' && t.source !== 'voidtrack') problems.push(`Unknown trigger source ${(t as { source?: string }).source}.`);
    else {
      if (!t.team?.trim()) problems.push('A trigger has no team.');
      if (!t.label?.trim()) problems.push('A trigger has no label.');
    }
  }
  if (!workflow.steps?.length) problems.push('Needs at least one step.');
  const ids = new Set<string>();
  for (const s of Array.isArray(workflow.steps) ? workflow.steps : []) {
    problems.push(...validateStep(s, config, dir));
    const id = typeof s === 'string' ? s : isObj(s) ? s.id : undefined;
    if (typeof id === 'string' && !isBuiltin(id)) {
      if (ids.has(id)) problems.push(`Step id ${id} is used twice.`);
      ids.add(id);
    }
  }
  // A step's own label must not be a label some workflow starts on.
  const labels = new Set([workflow, ...Object.values(config.workflows ?? {})].flatMap((w) => (Array.isArray(w.triggers) ? w.triggers : []).map((t) => (t as { label?: string }).label)));
  for (const id of ids) {
    if (labels.has(LABELS.step(id))) problems.push(`Step ${id} would label the card ${LABELS.step(id)}, which a workflow starts on. Rename the step.`);
  }
  if (!config.projects[workflow.project]) problems.push(`Project ${workflow.project} does not exist.`);
  if (!isInt(workflow.maxRounds, 1, 9)) problems.push('Rounds must be a whole number from 1 to 9.');
  const wb = workflow.writeBack;
  if (wb !== undefined) {
    if (!isObj(wb)) problems.push('writeBack must be an object.');
    else {
      if (wb.labels !== undefined && typeof wb.labels !== 'boolean') problems.push('writeBack.labels must be true or false.');
      if (wb.comment !== undefined && typeof wb.comment !== 'boolean') problems.push('writeBack.comment must be true or false.');
      if (wb.steps !== undefined && typeof wb.steps !== 'boolean') problems.push('writeBack.steps must be true or false.');
      if (wb.state !== undefined && wb.state !== null && (typeof wb.state !== 'string' || !wb.state.trim())) problems.push('writeBack.state must be a state name, or null to never move the card.');
    }
  }
  return problems;
}

// Everything wrong with an agent folder: its agent.json, its workflow and
// prompt files, and a name config.json already uses.
export function validateAgentFolder(dir: string, config: Pick<AgentsConfig, 'enabled' | 'projects' | 'workflows' | 'folders'>): string[] {
  let workflow: Workflow;
  try {
    workflow = readAgentFolder(dir);
  } catch (err) {
    return [`${AGENT_FILE}: ${(err as Error).message}`];
  }
  const name = basename(dir);
  const problems = validateWorkflow({ ...config, workflows: { ...config.workflows, [name]: workflow } }, workflow, dir);
  const from = config.folders?.[name];
  if (config.workflows[name] && (!from || resolve(from) !== resolve(dir))) problems.push(`config.json already has a workflow named ${name}, and it wins. Rename the folder.`);
  return problems;
}

export const TRIGGER_FORMS = 'TEAM:LABEL (Linear), voidtrack:TEAM:LABEL, or cron:SCHEDULE:TASK';

// "ENG:vs-plan" (Linear, also "linear:ENG:vs-plan"), "voidtrack:ORG:vs-start"
// or "cron:0 5 * * 1:Update the dependencies" into a trigger. Teams are
// upper-cased; a schedule must parse.
export function parseTrigger(input: string): Trigger | null {
  const text = input.trim();
  // A source prefix decides the form; a bare TEAM:LABEL is Linear.
  if (text.startsWith('cron:')) {
    const cron = /^cron:([^:]+):([\s\S]+)$/.exec(text);
    const schedule = cron?.[1]!.trim().replace(/\s+/g, ' ') ?? '';
    const task = cron?.[2]!.trim() ?? '';
    return parseCron(schedule) && task ? { source: 'cron', schedule, task } : null;
  }
  const m = /^(linear|voidtrack):/.test(text) ? /^(linear|voidtrack):([^:]+):(.+)$/.exec(text) : /^()([^:]+):(.+)$/.exec(text);
  if (!m) return null;
  const team = m[2]!.trim().toUpperCase();
  const label = m[3]!.trim();
  return team && label ? { source: (m[1] || 'linear') as 'linear' | 'voidtrack', team, label } : null;
}

export const sameTrigger = (a: Trigger, b: Trigger) => triggerSpec(a) === triggerSpec(b);

// Warning lines for triggers this workflow shares with another one. Only the
// first workflow in order starts a card, so the rest never get it.
export function duplicateTriggerWarnings(workflows: Record<string, Workflow>, name: string, workflow: Workflow): string[] {
  const lines: string[] = [];
  for (const t of workflow.triggers) {
    const owners = Object.entries(workflows).filter(([n, w]) => n === name || w.triggers.some((x) => sameTrigger(x, t))).map(([n]) => n);
    const first = owners[0];
    for (const other of owners) {
      if (other === name) continue;
      lines.push(`Warning: ${other} also starts on ${describeTrigger(t)}, and ${first} wins. vsf agents workflow move changes the order.`);
    }
  }
  return lines;
}

// Renames a key without moving it.
export function renameKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
}

export type Place = { first: true } | { last: true } | { before: string } | { after: string };

// Moves one entry to a new place in the order.
export function moveKey<T>(record: Record<string, T>, name: string, place: Place): Record<string, T> {
  const rest = Object.keys(record).filter((k) => k !== name);
  let at = 0;
  if ('last' in place) at = rest.length;
  else if ('before' in place) at = rest.indexOf(place.before);
  else if ('after' in place) at = rest.indexOf(place.after) + 1;
  if (at < 0 || (at === 0 && 'after' in place)) return record;
  rest.splice(at, 0, name);
  return Object.fromEntries(rest.map((k) => [k, record[k]!]));
}

export const workflowsUsing = (config: Pick<AgentsConfig, 'workflows'>, project: string) =>
  Object.entries(config.workflows).filter(([, w]) => w.project === project).map(([n]) => n);

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// What is wrong with the projects' workspaces and matches: a workspace that
// does not exist, or a tracker project name two projects both claim.
export function projectProblems(projects: AgentsConfig['projects'], workspaces: AgentsConfig['workspaces']): string[] {
  const problems: string[] = [];
  const claimed = new Map<string, string>();
  for (const [name, p] of Object.entries(projects)) {
    if (!isObj(p)) continue;
    if (p.workspace !== undefined && (typeof p.workspace !== 'string' || (p.workspace !== DEFAULT_WORKSPACE && !Object.hasOwn(workspaces, p.workspace)))) {
      problems.push(`Project ${name}: workspace ${String(p.workspace)} does not exist. vsf agents workspace add creates it.`);
    }
    if (p.match === undefined) continue;
    if (!Array.isArray(p.match) || p.match.some((m) => typeof m !== 'string' || !m.trim())) {
      problems.push(`Project ${name}: match must list tracker project names.`);
      continue;
    }
    for (const m of p.match) {
      const key = m.trim().toLowerCase();
      const other = claimed.get(key);
      if (other && other !== name) problems.push(`Projects ${other} and ${name} both match ${m}.`);
      else claimed.set(key, name);
    }
  }
  return problems;
}

// Everything wrong with a whole agents config, e.g. one edited by hand.
// `saved` is the config on disk: only what the write changes is checked, so a
// moved folder or a retired agent elsewhere does not block an unrelated edit.
export function validateConfig(value: unknown, saved?: Pick<AgentsConfig, 'projects' | 'workflows'> & Partial<Pick<AgentsConfig, 'workspaces'>>): string[] {
  if (!isObj(value)) return ['The config must be an object.'];
  const problems: string[] = [];
  if (value.engine !== 'claude' && value.engine !== 'codex') problems.push('engine must be claude or codex.');
  if (!isObj(value.models) || Object.values(value.models).some((m) => typeof m !== 'string')) problems.push('models must map names to text.');
  if (typeof value.reviewState !== 'string' || !value.reviewState.trim()) problems.push('reviewState must be a non-empty string.');
  if (!isInt(value.timeoutMinutes, 1, 480)) problems.push('timeoutMinutes must be a whole number from 1 to 480.');
  if (value.maxRuns !== undefined && !isInt(value.maxRuns, 0, 32)) problems.push('maxRuns must be a whole number from 0 to 32, 0 for no cap.');
  if (value.pauseAt !== undefined && !isInt(value.pauseAt, 0, 100)) problems.push('pauseAt must be a whole number from 0 to 100, 0 to never hold.');
  const projects = isObj(value.projects) ? value.projects : null;
  if (!projects) problems.push('projects must be an object.');
  for (const [name, p] of Object.entries(projects ?? {})) {
    if (!isObj(p) || typeof p.path !== 'string' || !p.path) problems.push(`Project ${name} needs a path.`);
    else if (saved?.projects?.[name]?.path !== p.path && !existsSync(join(p.path, '.git'))) problems.push(`Project ${name}: ${p.path} is not a git repository.`);
  }
  // Older configs have no workspaces: every project is in the default one.
  const workspaces = value.workspaces === undefined ? {} : isObj(value.workspaces) ? value.workspaces : null;
  if (!workspaces) problems.push('workspaces must be an object.');
  for (const [name, w] of Object.entries(workspaces ?? {})) {
    if (!WORKSPACE_NAME.test(name)) problems.push(`Workspace ${name} must be letters, digits, dashes and underscores.`);
    if (!isObj(w) || typeof w.root !== 'string' || !w.root) problems.push(`Workspace ${name} needs a root folder.`);
    else {
      if (saved?.workspaces?.[name]?.root !== w.root && !existsSync(w.root)) problems.push(`Workspace ${name}: ${w.root} does not exist.`);
      if (w.context !== undefined && typeof w.context !== 'string') problems.push(`Workspace ${name} context must be a file name.`);
    }
  }
  problems.push(...projectProblems((projects ?? {}) as AgentsConfig['projects'], (workspaces ?? {}) as AgentsConfig['workspaces']));
  if (!Array.isArray(value.enabled) || value.enabled.some((a) => typeof a !== 'string' || !(a in AGENTS))) problems.push(`enabled must list agents from: ${Object.keys(AGENTS).join(', ')}.`);
  if (value.commits !== undefined && (!isObj(value.commits) || Object.entries(value.commits).some(([k, v]) => !['signOff', 'dropAiTrailers'].includes(k) || typeof v !== 'boolean'))) problems.push('commits may only set signOff and dropAiTrailers, each true or false.');
  if (!Array.isArray(value.homes) || value.homes.some((h) => !isObj(h) || (h.kind !== 'claude' && h.kind !== 'codex') || typeof h.dir !== 'string')) problems.push('homes must be a list of { kind: claude or codex, dir }.');
  if (!isObj(value.workflows)) problems.push('workflows must be an object.');
  else {
    const ctx = { enabled: Array.isArray(value.enabled) ? (value.enabled as StepId[]) : [], projects: (projects ?? {}) as AgentsConfig['projects'], workflows: value.workflows as AgentsConfig['workflows'] };
    for (const [name, w] of Object.entries(value.workflows)) {
      // Folder workflows are checked with their folder, by vsf agents validate.
      if (isObj(value.folders) && value.folders[name]) continue;
      if (!isObj(w)) problems.push(`Workflow ${name} must be an object.`);
      else {
        // An unchanged workflow using a step that is not enabled is only a warning.
        const unchanged = !!saved?.workflows?.[name] && JSON.stringify(saved.workflows[name]) === JSON.stringify(w);
        for (const p of validateWorkflow(unchanged ? { ...ctx, enabled: [] } : ctx, w as Workflow)) problems.push(`Workflow ${name}: ${p}`);
      }
    }
  }
  return problems;
}
