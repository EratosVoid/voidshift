import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABELS,
  buildPrompt,
  findingsFor,
  isRoundLabel,
  latestPlan,
  parseDevResult,
  parseVerdict,
  qaPassed,
  type StepResult,
} from './chain.ts';
import { STEPS, agentsDir, allChains, hasWork, type AgentsConfig, type Chain, type Project, type Trigger } from './config.ts';
import { runAgent } from './engine.ts';
import { commitsAhead, defaultBranch, ensureDraftPr, ensureWorktree, markReady, push, waitForChecks } from './git.ts';
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

// One card through a trigger's chain. Every round runs the steps in order;
// a failed check starts the next round with the findings, so the work step
// fixes them, until the checks pass or the round cap parks the card.
export async function runCard(card: Card, trigger: Trigger, chain: Chain, project: Project, rc: RunContext): Promise<'verified' | 'changes' | 'parked'> {
  const { linear, config, log } = rc;
  const runDir = join(agentsDir(rc.configDir), 'runs', card.identifier, stamp());
  mkdirSync(runDir, { recursive: true });
  const say = (line: string) => log(`${card.identifier} ${line}`);
  const work = hasWork(chain);

  async function park(reason: string): Promise<'parked'> {
    say(`parked: ${reason}`);
    await linear.comment(card, `**VoidShift parked this card.** ${reason}\n\nFix the cause, then add \`${trigger.label}\` again to retry.`);
    await linear.setLabels(card, withLabels(card, (l) => l === trigger.label || l === LABELS.working, [LABELS.parked]));
    return 'parked';
  }

  try {
    if (!existsSync(join(project.path, '.git'))) throw new Park(`The project folder ${project.path} is not a git repository on this Mac.`);
    const plan = latestPlan(await linear.comments(card.identifier));
    if (work && !plan) throw new Park('No comment starting with "## VoidShift plan" was found. Publish a plan with vs-publish first.');

    await linear.setLabels(card, withLabels(card, (l) => l === trigger.label || statusLabel(l), [LABELS.working]));
    const base = defaultBranch(project.path);
    const worktree = join(agentsDir(rc.configDir), 'worktrees', card.identifier);
    ensureWorktree(project.path, worktree, card.branchName, base);
    if (!work && commitsAhead(worktree, base) === 0) throw new Park(`Branch ${card.branchName} has no changes to check.`);
    say(`working in ${worktree} on ${card.branchName}`);

    const planText = plan ?? '(No plan was posted on this card. Check the change against the card itself.)';
    let findings: string | undefined;
    let prUrl = '';
    for (let round = 1; round <= chain.maxRounds; round++) {
      const checks: StepResult[] = [];
      for (const step of chain.steps) {
        say(`round ${round}: ${STEPS[step].label}`);
        const log = (name: string) => join(runDir, `r${round}-${name}.log`);
        if (step === 'vs-dev') {
          const dev = await runAgent({
            engine: config.engine, model: config.models.dev, cwd: worktree, write: true, logFile: log('dev'),
            prompt: buildPrompt({ skill: skill('vs-dev'), card, plan: planText, base, round, findings }),
          });
          const result = parseDevResult(dev.output);
          if (result.status === 'blocked') throw new Park(`The dev agent stopped: ${result.reason}`);
          if (commitsAhead(worktree, base) === 0) throw new Park('The dev agent made no commits.');
          push(worktree, card.branchName);
          prUrl = ensureDraftPr(worktree, card.branchName, base, `${card.identifier}: ${card.title}`, `${card.url}\n\nOpened by VoidShift.`);
          await linear.setLabels(card, withLabels(card, () => false, [LABELS.dev(round)]));
        } else if (step === 'ci') {
          checks.push({ step: 'CI', ...(await waitForChecks(worktree, card.branchName)) });
        } else if (step === 'vs-qa-review') {
          const r = await runAgent({
            engine: config.engine, model: config.models.review, cwd: worktree, write: false, logFile: log('review'),
            prompt: buildPrompt({ skill: skill('vs-qa-review'), card, plan: planText, base, round }),
          });
          checks.push({ step: 'Code review', verdict: parseVerdict(r.output), report: r.output });
        } else if (step === 'vs-qa-ui') {
          if (!project.uiUrl) {
            checks.push({ step: 'Browser', verdict: 'SKIP', report: 'No app URL set for this project.' });
            continue;
          }
          const evidence = join(runDir, `r${round}-ui`);
          mkdirSync(evidence, { recursive: true });
          const r = await runAgent({
            engine: config.engine, model: config.models.ui, cwd: worktree, write: false, logFile: log('ui'),
            prompt: buildPrompt({ skill: skill('vs-qa-ui'), card, plan: planText, base, round, extra: `# Where\n\nApp URL: ${project.uiUrl}\nEvidence folder: ${evidence}` }),
          });
          checks.push({ step: 'Browser', verdict: parseVerdict(r.output), report: r.output });
        }
      }

      const summary = checks.map((r) => `- ${r.step}: ${r.verdict}`).join('\n') || '- no checks in this chain';
      if (checks.length) await linear.setLabels(card, withLabels(card, () => false, [LABELS.qa(round)]));

      if (qaPassed(checks)) {
        let moved = false;
        if (work) {
          markReady(worktree, card.branchName);
          moved = await linear.moveTo(card, config.reviewState);
        }
        await linear.setLabels(card, withLabels(card, (l) => l === LABELS.working, [LABELS.verified]));
        await linear.comment(card, `**VoidShift: checks passed on round ${round}.**\n\n${summary}${prUrl ? `\n\nPR ready for review: ${prUrl}` : ''}${work && !moved ? `\n\n(No "${config.reviewState}" state on this team, so the card was not moved.)` : ''}`);
        say(`verified on round ${round}`);
        return 'verified';
      }

      findings = findingsFor(checks);
      await linear.comment(card, `**VoidShift round ${round}: changes needed.**\n\n${summary}\n\n${findings}`);
      if (!work) {
        await linear.setLabels(card, withLabels(card, (l) => l === LABELS.working, [LABELS.changes]));
        say('changes requested');
        return 'changes';
      }
    }
    throw new Park(`Checks still failed after ${chain.maxRounds} rounds. Latest findings are in the comment above. PR: ${prUrl}`);
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
