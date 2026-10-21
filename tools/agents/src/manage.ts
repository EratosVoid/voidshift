import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, STEPS, type AgentsConfig, type StepId, type Trigger, type Workflow } from './config.ts';

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// Everything wrong with one workflow, in plain words. Empty means it is fine.
export function validateWorkflow(config: Pick<AgentsConfig, 'enabled' | 'projects'>, workflow: Workflow): string[] {
  const problems: string[] = [];
  if (!workflow.triggers?.length) problems.push('Needs at least one trigger.');
  for (const t of workflow.triggers ?? []) {
    if (!t.team?.trim()) problems.push('A trigger has no team.');
    if (!t.label?.trim()) problems.push('A trigger has no label.');
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

// "ENG:vs-plan" into a trigger; the team is upper-cased.
export function parseTrigger(input: string): Trigger | null {
  const i = input.indexOf(':');
  if (i < 0) return null;
  const team = input.slice(0, i).trim().toUpperCase();
  const label = input.slice(i + 1).trim();
  return team && label ? { source: 'linear', team, label } : null;
}

export const sameTrigger = (a: Trigger, b: Trigger) => a.team === b.team && a.label === b.label;

// Warning lines for triggers this workflow shares with another one. Only the
// first workflow in order starts a card, so the rest never get it.
export function duplicateTriggerWarnings(workflows: Record<string, Workflow>, name: string, workflow: Workflow): string[] {
  const lines: string[] = [];
  for (const t of workflow.triggers) {
    const owners = Object.entries(workflows).filter(([n, w]) => n === name || w.triggers.some((x) => sameTrigger(x, t))).map(([n]) => n);
    const first = owners[0];
    for (const other of owners) {
      if (other === name) continue;
      lines.push(`Warning: ${other} also starts on ${t.team} + ${t.label}, and ${first} wins. vsf agents workflow move changes the order.`);
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
