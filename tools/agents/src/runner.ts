import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABELS,
  PLAN_HEADING,
  buildPrompt,
  findingsFor,
  fixTarget,
  isRoundLabel,
  latestPlan,
  parseDevResult,
  parseVerdict,
  planBody,
  qaPassed,
  verdictBlock,
  type StepResult,
} from './chain.ts';
import { STEPS, agentsDir, allChains, hasWork, isProducer, type AgentsConfig, type Chain, type Project, type StepId, type Trigger } from './config.ts';
import { runAgent } from './engine.ts';
import { commitsAhead, defaultBranch, ensureDraftPr, ensureWorktree, markReady, push, resetWorktree, waitForChecks } from './git.ts';
import type { Card, Linear } from './linear.ts';

const packDir = fileURLToPath(new URL('../pack/', import.meta.url));
const skill = (name: string) => readFileSync(join(packDir, name, 'SKILL.md'), 'utf8');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

class Park extends Error {}

export interface RunContext {
  configDir: string;
  config: AgentsConfig;
  linear: Linear;
  log: (line: string) => void;
}

function withLabels(card: Card, drop: (l: string) => boolean, add: string[]): string[] {
  return [...new Set([...card.labels.filter((l) => !drop(l)), ...add])];
}

const statusLabel = (l: string) =>
  l === LABELS.working || l === LABELS.verified || l === LABELS.parked || l === LABELS.changes || isRoundLabel(l);

const UNATTENDED = `# Running unattended

You are one step in a VoidShift chain. Nobody can answer questions and the
Linear connection is not available: the card and any plan are included above.
Do not write plan files; return your output as your final message. Make the
call the code supports and state it.`;

const isVerdict = (s: StepId) => STEPS[s].output === 'verdict';

// One card through a trigger's chain. Steps run in order. A failed check (or a
// run of consecutive checks) sends its findings back to the nearest earlier
// step that produces something, Plan or Dev, and the chain continues from
// there, until everything passes or the loop cap parks the card.
export async function runCard(card: Card, trigger: Trigger, chain: Chain, project: Project, rc: RunContext): Promise<'verified' | 'changes' | 'parked'> {
  const { linear, config, log } = rc;
  const runDir = join(agentsDir(rc.configDir), 'runs', card.identifier, stamp());
  mkdirSync(runDir, { recursive: true });
  const say = (line: string) => log(`${card.identifier} ${line}`);
  const steps = chain.steps;

  async function park(reason: string): Promise<'parked'> {
    say(`parked: ${reason}`);
    await linear.comment(card, `**VoidShift parked this card.** ${reason}\n\nFix the cause, then add \`${trigger.label}\` again to retry.`);
    await linear.setLabels(card, withLabels(card, (l) => l === trigger.label || l === LABELS.working, [LABELS.parked]));
    return 'parked';
  }

  try {
    if (!existsSync(join(project.path, '.git'))) throw new Park(`The project folder ${project.path} is not a git repository on this Mac.`);
    let plan = latestPlan(await linear.comments(card.identifier));
    const firstPlan = steps.indexOf('vs-plan');
    const needsPlan = steps.findIndex((s) => s === 'vs-dev' || s === 'vs-plan-review');
    if (!plan && needsPlan >= 0 && (firstPlan < 0 || firstPlan > needsPlan)) {
      throw new Park('No comment starting with "## VoidShift plan" was found. Publish a plan first, or start the chain with Plan.');
    }

    await linear.setLabels(card, withLabels(card, (l) => l === trigger.label || statusLabel(l), [LABELS.working]));
    const base = defaultBranch(project.path);
    const worktree = join(agentsDir(rc.configDir), 'worktrees', card.identifier);
    ensureWorktree(project.path, worktree, card.branchName, base);
    say(`working in ${worktree} on ${card.branchName}`);

    const findings = new Map<number, string>();
    const runs = { plan: 0, dev: 0, qa: 0 };
    let loops = 0;
    let prUrl = '';
    const planText = () => plan ?? '(No plan was posted on this card. Check the work against the card itself.)';
    const logFile = (name: string) => join(runDir, `${String(runs.plan + runs.dev + runs.qa).padStart(2, '0')}-${name}.log`);

    async function check(step: StepId): Promise<StepResult> {
      const label = STEPS[step].label;
      let ciNote = '';
      if (step === 'vs-qa') {
        if (commitsAhead(worktree, base) === 0) return { step: label, verdict: 'SKIP', report: 'No changes on the branch yet.' };
        // CI first, without an agent: a red build goes straight back.
        if (prUrl) {
          const ci = await waitForChecks(worktree, card.branchName);
          if (ci.verdict === 'FIX') return { step: label, verdict: 'FIX', report: ci.report };
          ciNote = ci.verdict === 'SHIP' ? '# CI\n\nCI passed on this branch.' : '# CI\n\nThis repo has no CI checks.';
        }
      }
      const r = await runAgent({
        engine: config.engine, model: config.models.review, cwd: worktree, write: step === 'vs-qa', logFile: logFile(step),
        prompt: buildPrompt({ skill: skill(step), card, plan: planText(), base, round: runs.qa + 1, extra: [ciNote, UNATTENDED].filter(Boolean).join('\n\n') }),
      });
      if (step === 'vs-qa') resetWorktree(worktree);
      return { step: label, verdict: parseVerdict(r.output), report: r.output };
    }

    let i = 0;
    while (i < steps.length) {
      const step = steps[i]!;
      say(`${STEPS[step].label}`);

      if (isVerdict(step)) {
        const [start, end] = verdictBlock(steps, i, isVerdict);
        const results: StepResult[] = [];
        for (const s of steps.slice(start, end)) results.push(await check(s));
        runs.qa++;
        await linear.setLabels(card, withLabels(card, () => false, [LABELS.qa(runs.qa)]));
        const summary = results.map((r) => `- ${r.step}: ${r.verdict}`).join('\n');
        if (qaPassed(results)) {
          i = end;
          continue;
        }
        const notes = findingsFor(results);
        await linear.comment(card, `**VoidShift: changes needed.**\n\n${summary}\n\n${notes}`);
        const target = fixTarget(steps, start, isProducer);
        if (target < 0) {
          await linear.setLabels(card, withLabels(card, (l) => l === LABELS.working, [LABELS.changes]));
          say('changes requested');
          return 'changes';
        }
        if (++loops > chain.maxRounds) throw new Park(`Checks still failed after sending the work back ${chain.maxRounds} times. Latest findings are in the comment above.${prUrl ? ` PR: ${prUrl}` : ''}`);
        findings.set(target, notes);
        i = target;
        continue;
      }

      if (step === 'vs-plan') {
        const r = await runAgent({
          engine: config.engine, model: config.models.dev, cwd: worktree, write: false, logFile: logFile('plan'),
          prompt: buildPrompt({ skill: skill('vs-plan'), card, plan: plan ?? '(none yet, you are writing it)', base, round: runs.plan + 1, findings: findings.get(i), extra: UNATTENDED }),
        });
        const result = parseDevResult(r.output);
        if (result.status === 'blocked') throw new Park(`The plan agent stopped: ${result.reason}`);
        plan = planBody(r.output);
        await linear.comment(card, `${PLAN_HEADING}\n\n${plan}`);
        runs.plan++;
        await linear.setLabels(card, withLabels(card, () => false, [LABELS.plan(runs.plan)]));
      } else if (step === 'vs-publish') {
        push(worktree, card.branchName);
      } else if (step === 'vs-dev') {
        const dev = await runAgent({
          engine: config.engine, model: config.models.dev, cwd: worktree, write: true, logFile: logFile('dev'),
          prompt: buildPrompt({ skill: skill('vs-dev'), card, plan: planText(), base, round: runs.dev + 1, findings: findings.get(i) }),
        });
        const result = parseDevResult(dev.output);
        if (result.status === 'blocked') throw new Park(`The dev agent stopped: ${result.reason}`);
        if (commitsAhead(worktree, base) === 0) throw new Park('The dev agent made no commits.');
        push(worktree, card.branchName);
        prUrl = ensureDraftPr(worktree, card.branchName, base, `${card.identifier}: ${card.title}`, `${card.url}\n\nOpened by VoidShift.`);
        runs.dev++;
        await linear.setLabels(card, withLabels(card, () => false, [LABELS.dev(runs.dev)]));
      }
      findings.delete(i);
      i++;
    }

    let moved = false;
    if (hasWork(chain)) {
      markReady(worktree, card.branchName);
      moved = await linear.moveTo(card, config.reviewState);
    }
    await linear.setLabels(card, withLabels(card, (l) => l === LABELS.working, [LABELS.verified]));
    await linear.comment(card, `**VoidShift: chain ${trigger.chain} finished, every check passed.**${prUrl ? `\n\nPR ready for review: ${prUrl}` : ''}${hasWork(chain) && !moved ? `\n\n(No "${config.reviewState}" state on this team, so the card was not moved.)` : ''}`);
    say('verified');
    return 'verified';
  } catch (err) {
    if (err instanceof Park) return park(err.message);
    return park(`Something went wrong: ${(err as Error).message}`);
  }
}

// The first card waiting on any trigger, in trigger order.
export async function nextJob(rc: RunContext, only?: string): Promise<{ card: Card; trigger: Trigger } | null> {
  for (const trigger of rc.config.triggers) {
    const cards = only ? [await rc.linear.card(only)] : await rc.linear.myCardsWithLabel(trigger.label);
    const card = cards.find((c) => c.teamKey === trigger.team && c.labels.includes(trigger.label));
    if (card) return { card, trigger };
  }
  return null;
}

// One pass for the background runner. A lock keeps two passes from working at once.
export async function tick(rc: RunContext, only?: string): Promise<number> {
  const lock = join(agentsDir(rc.configDir), 'runner.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 0);
      return 0;
    } catch {
      // stale lock from a dead run
    }
  }
  mkdirSync(agentsDir(rc.configDir), { recursive: true });
  writeFileSync(lock, String(process.pid));
  try {
    const job = await nextJob(rc, only);
    if (!job) {
      if (only) rc.log(`${only} matches no trigger: it needs a trigger's team and label.`);
      return only ? 1 : 0;
    }
    const chain = allChains(rc.config)[job.trigger.chain];
    const project = rc.config.projects[job.trigger.project];
    if (!chain || !project) {
      rc.log(`Trigger ${job.trigger.team} + ${job.trigger.label} points at a missing chain or project. Run voidshift to fix it.`);
      return 1;
    }
    const outcome = await runCard(job.card, job.trigger, chain, project, rc);
    return outcome === 'verified' ? 0 : 1;
  } finally {
    rmSync(lock, { force: true });
  }
}
