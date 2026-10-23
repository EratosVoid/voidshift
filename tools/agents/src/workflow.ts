// The build workflow and the pure decisions around it. The runner does the I/O;
// everything here is testable without Linear, git or an agent.

export const PLAN_HEADING = '## Plan';
// Plans posted before 0.1.5 used this heading; still read them.
const OLD_PLAN_HEADING = '## VoidShift plan';

// A card carries at most two VoidShift labels: one stage label (which agent has
// it, or how it ended) and one version label (which round it is on).
export const LABELS = {
  stage: {
    'vs-plan': 'vs-planning',
    'vs-plan-review': 'vs-plan-review',
    'vs-publish': 'vs-publish',
    'vs-dev': 'vs-dev',
    'vs-qa': 'vs-qa',
  } as Record<string, string>,
  changes: 'vs-changes-requested',
  verified: 'vs-qa-verified',
  parked: 'vs-parked',
  version: (round: number) => `vs-v${round}`,
  // Labels from earlier runners, still cleaned off cards.
  working: 'vs-working',
};

const STAGE_NAMES = new Set([...Object.values(LABELS.stage), LABELS.changes, LABELS.verified, LABELS.parked, LABELS.working]);

export const isVersionLabel = (name: string) => /^vs-v\d+$/.test(name);
// Round labels earlier runners stacked up, one per step and round.
export const isRoundLabel = (name: string) => /^vs-(plan|review|dev|qa)-v\d+$/.test(name);

export const isStatusLabel = (name: string) => STAGE_NAMES.has(name) || isVersionLabel(name) || isRoundLabel(name);

// The card's labels with every VoidShift label (and the trigger) replaced by
// one stage label and, when given, one version label.
export function stageLabels(current: string[], trigger: string, stage: string, round?: number): string[] {
  const kept = current.filter((l) => l !== trigger && !isStatusLabel(l));
  return [...new Set([...kept, stage, ...(round ? [LABELS.version(round)] : [])])];
}

export type Verdict = 'SHIP' | 'FIX' | 'SKIP';

export interface StepResult {
  step: string;
  verdict: Verdict;
  report: string;
}

// The last "VERDICT: X" line wins; anything unreadable counts as FIX so a
// confused agent never waves a change through.
export function parseVerdict(output: string): Verdict {
  const matches = [...output.matchAll(/^\s*VERDICT:\s*(SHIP|FIX|SKIP)\b/gim)];
  const last = matches.at(-1)?.[1]?.toUpperCase();
  return last === 'SHIP' || last === 'SKIP' ? last : 'FIX';
}

export type DevResult = { status: 'done' } | { status: 'blocked'; reason: string };

export function parseDevResult(output: string): DevResult {
  const matches = [...output.matchAll(/^\s*RESULT:\s*(DONE|BLOCKED)\b\s*(.*)$/gim)];
  const last = matches.at(-1);
  if (last?.[1]?.toUpperCase() === 'DONE') return { status: 'done' };
  if (last?.[1]?.toUpperCase() === 'BLOCKED') return { status: 'blocked', reason: last[2]?.trim() || 'no reason given' };
  return { status: 'blocked', reason: 'the dev agent ended without a RESULT line' };
}

export function qaPassed(results: StepResult[]): boolean {
  return results.every((r) => r.verdict !== 'FIX');
}

// What the dev agent sees on the next round.
export function findingsFor(results: StepResult[]): string {
  const failed = results.filter((r) => r.verdict === 'FIX');
  if (failed.length === 1) return failed[0]!.report.trim();
  return failed.map((r) => `### ${r.step}\n\n${r.report.trim()}`).join('\n\n');
}

export function latestPlan(comments: { body: string; createdAt: string }[]): string | null {
  const headingOf = (body: string) => {
    const first = body.trimStart().split('\n', 1)[0]!.trim();
    return first === PLAN_HEADING || first === OLD_PLAN_HEADING ? first : null;
  };
  const plans = comments
    .filter((c) => headingOf(c.body))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const last = plans.at(-1);
  return last ? last.body.trimStart().slice(headingOf(last.body)!.length).trim() : null;
}

// Strip the frontmatter from a SKILL.md so the body can be inlined.
export function skillBody(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

export interface PromptInput {
  skill: string;
  card: { identifier: string; title: string; description?: string; url?: string };
  plan: string;
  base: string;
  round: number;
  findings?: string;
  extra?: string;
}

export function buildPrompt(p: PromptInput): string {
  const parts = [
    skillBody(p.skill),
    '---',
    `# Card ${p.card.identifier}: ${p.card.title}`,
    p.card.url ? p.card.url : '',
    p.card.description?.trim() || '(no description)',
    '# Plan',
    p.plan,
    `# Round\n\nRound ${p.round}. Base branch: \`${p.base}\`.`,
  ];
  if (p.findings) parts.push('# Findings to address', p.findings);
  if (p.extra) parts.push(p.extra);
  return parts.filter(Boolean).join('\n\n');
}

// Consecutive verdict steps run as one block so every finding comes back at
// once. Returns [start, end) of the block that starts at `i`.
export function verdictBlock<T>(steps: T[], i: number, isVerdict: (s: T) => boolean): [number, number] {
  let end = i;
  while (end < steps.length && isVerdict(steps[end]!)) end++;
  return [i, end];
}

// Where a failed check sends the work: the nearest earlier step that produces
// something. -1 means nothing to send it back to.
export function fixTarget<T>(steps: T[], blockStart: number, isProducer: (s: T) => boolean): number {
  for (let j = blockStart - 1; j >= 0; j--) if (isProducer(steps[j]!)) return j;
  return -1;
}

// Plan output minus the trailing RESULT line, ready to post.
export function planBody(output: string): string {
  return output.replace(/^\s*RESULT:.*$/gim, '').trim();
}
