// The build chain and the pure decisions around it. The runner does the I/O;
// everything here is testable without Linear, git or an agent.

export const PLAN_HEADING = '## VoidShift plan';

export const LABELS = {
  working: 'vs-working',
  changes: 'vs-changes-requested',
  verified: 'vs-qa-verified',
  parked: 'vs-parked',
  dev: (round: number) => `vs-dev-v${round}`,
  qa: (round: number) => `vs-qa-v${round}`,
};

export const isRoundLabel = (name: string) => /^vs-(dev|qa)-v\d+$/.test(name);

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
  return results
    .filter((r) => r.verdict === 'FIX')
    .map((r) => `### ${r.step}\n\n${r.report.trim()}`)
    .join('\n\n');
}

export function latestPlan(comments: { body: string; createdAt: string }[]): string | null {
  const plans = comments
    .filter((c) => c.body.trimStart().startsWith(PLAN_HEADING))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const last = plans.at(-1);
  return last ? last.body.trimStart().slice(PLAN_HEADING.length).trim() : null;
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
  if (p.findings) parts.push('# QA findings to fix', p.findings);
  if (p.extra) parts.push(p.extra);
  return parts.filter(Boolean).join('\n\n');
}
