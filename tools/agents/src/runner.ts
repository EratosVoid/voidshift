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
import { agentsDir, lookup, type AgentsConfig } from './config.ts';
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

const ours = (l: string) =>
  l === LABELS.trigger || l === LABELS.working || l === LABELS.verified || l === LABELS.parked || isRoundLabel(l);

// One card through the chain: dev, then CI, review and browser QA, looping
// back to dev on FIX until QA passes or the round cap parks it.
export async function runCard(card: Card, rc: RunContext): Promise<'verified' | 'parked'> {
  const { linear, config, log } = rc;
  const runDir = join(agentsDir(rc.configDir), 'runs', card.identifier, stamp());
  mkdirSync(runDir, { recursive: true });
  const say = (line: string) => log(`${card.identifier} ${line}`);

  async function park(reason: string): Promise<'parked'> {
    say(`parked: ${reason}`);
    await linear.comment(card, `**VoidShift parked this card.** ${reason}\n\nFix the cause, then add \`${LABELS.trigger}\` again to retry.`);
    await linear.setLabels(card, withLabels(card, (l) => l === LABELS.trigger || l === LABELS.working, [LABELS.parked]));
    return 'parked';
  }

  try {
    const repo = lookup(config.repos, card);
    if (!repo || !existsSync(repo)) {
      throw new Park(`No local repo is mapped for team ${card.teamKey}${card.projectName ? ` or project ${card.projectName}` : ''}. Run \`voidshift agents repo ${card.teamKey} <path>\`.`);
    }
    const plan = latestPlan(await linear.comments(card.identifier));
    if (!plan) throw new Park('No comment starting with "## VoidShift plan" was found. Publish a plan with vs-publish first.');

    await linear.setLabels(card, withLabels(card, (l) => ours(l), [LABELS.working]));
    const base = defaultBranch(repo);
    const worktree = join(agentsDir(rc.configDir), 'worktrees', card.identifier);
    ensureWorktree(repo, worktree, card.branchName, base);
    say(`working in ${worktree} on ${card.branchName}`);

    let findings: string | undefined;
    let prUrl = '';
    for (let round = 1; round <= config.maxRounds; round++) {
      say(`round ${round}: dev`);
      const before = commitsAhead(worktree, base);
      const dev = await runAgent({
        engine: config.engine,
        model: config.models.dev,
        cwd: worktree,
        write: true,
        logFile: join(runDir, `r${round}-dev.log`),
        prompt: buildPrompt({ skill: skill('vs-dev'), card, plan, base, round, findings }),
      });
      const result = parseDevResult(dev.output);
      if (result.status === 'blocked') throw new Park(`The dev agent stopped: ${result.reason}`);
      if (commitsAhead(worktree, base) === 0) throw new Park('The dev agent made no commits.');
      if (round > 1 && commitsAhead(worktree, base) === before) say('dev made no new commits this round');

      push(worktree, card.branchName);
      prUrl = ensureDraftPr(worktree, card.branchName, base, `${card.identifier}: ${card.title}`, `${card.url}\n\nOpened by VoidShift.`);
      await linear.setLabels(card, withLabels(card, () => false, [LABELS.dev(round)]));

      say(`round ${round}: qa`);
      const qa: StepResult[] = [];
      const ci = await waitForChecks(worktree, card.branchName);
      qa.push({ step: 'CI', ...ci });

      const review = await runAgent({
        engine: config.engine,
        model: config.models.review,
        cwd: worktree,
        write: false,
        logFile: join(runDir, `r${round}-review.log`),
        prompt: buildPrompt({ skill: skill('vs-qa-review'), card, plan, base, round }),
      });
      qa.push({ step: 'Code review', verdict: parseVerdict(review.output), report: review.output });

      const url = lookup(config.uiUrls, card);
      if (url) {
        const evidence = join(runDir, `r${round}-ui`);
        mkdirSync(evidence, { recursive: true });
        const ui = await runAgent({
          engine: config.engine,
          model: config.models.ui,
          cwd: worktree,
          write: false,
          logFile: join(runDir, `r${round}-ui.log`),
          prompt: buildPrompt({ skill: skill('vs-qa-ui'), card, plan, base, round, extra: `# Where\n\nApp URL: ${url}\nEvidence folder: ${evidence}` }),
        });
        qa.push({ step: 'Browser', verdict: parseVerdict(ui.output), report: ui.output });
      }

      const summary = qa.map((r) => `- ${r.step}: ${r.verdict}`).join('\n');
      await linear.setLabels(card, withLabels(card, () => false, [LABELS.qa(round)]));

      if (qaPassed(qa)) {
        markReady(worktree, card.branchName);
        await linear.setLabels(card, withLabels(card, (l) => l === LABELS.working, [LABELS.verified]));
        const moved = await linear.moveTo(card, config.reviewState);
        await linear.comment(card, `**VoidShift: QA verified on round ${round}.**\n\n${summary}\n\nPR ready for review: ${prUrl}${moved ? '' : `\n\n(No "${config.reviewState}" state on this team, so the card was not moved.)`}`);
        say(`verified on round ${round}`);
        return 'verified';
      }

      findings = findingsFor(qa);
      await linear.comment(card, `**VoidShift QA round ${round}: changes needed.**\n\n${summary}\n\n${findings}`);
    }
    throw new Park(`QA still failed after ${config.maxRounds} rounds. Latest findings are in the comment above. PR: ${prUrl}`);
  } catch (err) {
    if (err instanceof Park) return park(err.message);
    return park(`Something went wrong: ${(err as Error).message}`);
  }
}

// One pass for the background runner: pick the oldest eligible card, if any.
// A lock keeps two passes from working at once.
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
    const card = only ? await rc.linear.card(only) : (await rc.linear.myCardsWithLabel(LABELS.trigger))[0];
    if (!card) return 0;
    if (only && !card.labels.includes(LABELS.trigger)) {
      rc.log(`${card.identifier} has no ${LABELS.trigger} label; publish its plan first.`);
      return 1;
    }
    const outcome = await runCard(card, rc);
    return outcome === 'verified' ? 0 : 1;
  } finally {
    rmSync(lock, { force: true });
  }
}
