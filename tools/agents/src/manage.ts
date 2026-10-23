import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, STEPS, describeTrigger, triggerSpec, type AgentsConfig, type StepId, type Trigger, type Workflow } from './config.ts';
import { parseCron } from './cron.ts';

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// Everything wrong with one workflow, in plain words. Empty means it is fine.
export function validateWorkflow(config: Pick<AgentsConfig, 'enabled' | 'projects'>, workflow: Workflow): string[] {
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
  for (const s of workflow.steps ?? []) {
    if (!(s in STEPS)) problems.push(`Unknown step ${s}.`);
    else if (config.enabled.length && !config.enabled.includes(s)) problems.push(`Step ${s} is not enabled.`);
  }
  if (!config.projects[workflow.project]) problems.push(`Project ${workflow.project} does not exist.`);
  if (!isInt(workflow.maxRounds, 1, 9)) problems.push('Rounds must be a whole number from 1 to 9.');
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

// Everything wrong with a whole agents config, e.g. one edited by hand.
// `saved` is the config on disk: only what the write changes is checked, so a
// moved folder or a retired agent elsewhere does not block an unrelated edit.
export function validateConfig(value: unknown, saved?: Pick<AgentsConfig, 'projects' | 'workflows'>): string[] {
  if (!isObj(value)) return ['The config must be an object.'];
  const problems: string[] = [];
  if (value.engine !== 'claude' && value.engine !== 'codex') problems.push('engine must be claude or codex.');
  if (!isObj(value.models) || Object.values(value.models).some((m) => typeof m !== 'string')) problems.push('models must map names to text.');
  if (typeof value.reviewState !== 'string' || !value.reviewState.trim()) problems.push('reviewState must be a non-empty string.');
  if (!isInt(value.timeoutMinutes, 1, 480)) problems.push('timeoutMinutes must be a whole number from 1 to 480.');
  const projects = isObj(value.projects) ? value.projects : null;
  if (!projects) problems.push('projects must be an object.');
  for (const [name, p] of Object.entries(projects ?? {})) {
    if (!isObj(p) || typeof p.path !== 'string' || !p.path) problems.push(`Project ${name} needs a path.`);
    else if (saved?.projects?.[name]?.path !== p.path && !existsSync(join(p.path, '.git'))) problems.push(`Project ${name}: ${p.path} is not a git repository.`);
  }
  if (!Array.isArray(value.enabled) || value.enabled.some((a) => typeof a !== 'string' || !(a in AGENTS))) problems.push(`enabled must list agents from: ${Object.keys(AGENTS).join(', ')}.`);
  if (!Array.isArray(value.homes) || value.homes.some((h) => !isObj(h) || (h.kind !== 'claude' && h.kind !== 'codex') || typeof h.dir !== 'string')) problems.push('homes must be a list of { kind: claude or codex, dir }.');
  if (!isObj(value.workflows)) problems.push('workflows must be an object.');
  else {
    const ctx = { enabled: Array.isArray(value.enabled) ? (value.enabled as StepId[]) : [], projects: (projects ?? {}) as AgentsConfig['projects'] };
    for (const [name, w] of Object.entries(value.workflows)) {
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
