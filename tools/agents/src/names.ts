import { STEPS, STEP_ID, type StepId } from './config.ts';

// A workflow or project named in a command: the exact name, or the start of
// exactly one name, e.g. "tether" for tether-relay-build.
export function resolveName(names: string[], input: string, kind: string): { name: string } | { error: string } {
  if (!input.trim()) return { error: `Give a ${kind} name.` };
  if (names.includes(input)) return { name: input };
  const matches = names.filter((n) => n.startsWith(input));
  if (matches.length === 1) return { name: matches[0]! };
  if (!matches.length) return { error: `No ${kind} named ${input}.${names.length ? ` There are: ${names.join(', ')}.` : ''}` };
  return { error: `${input} matches ${matches.join(', ')}. Type more of the name.` };
}

// Short step names for commands: plan, plan-review, publish, dev, qa. The
// full ids (vs-dev) and labels (Dev, "Plan review") work too.
export function parseStep(input: string): StepId | null {
  const v = input.trim().toLowerCase().replace(/\s+/g, '-');
  for (const id of Object.keys(STEPS) as StepId[]) {
    if (v === id || `vs-${v}` === id || STEPS[id].label.toLowerCase().replace(/\s+/g, '-') === v) return id;
  }
  return null;
}

// A step for --from: a built-in step by any of its names, or any id a custom
// step could have. Whether the workflow has it is checked once it is known.
export const parseFrom = (input: string): string | null => parseStep(input) ?? (STEP_ID.test(input) ? input : null);

export const stepNames = () => (Object.keys(STEPS) as StepId[]).map((id) => id.replace(/^vs-/, '')).join(', ');
