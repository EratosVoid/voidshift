import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABELS,
  PLAN_HEADING,
  buildPrompt,
  findingsFor,
  fixTarget,
  isStatusLabel,
  latestPlan,
  parseDevResult,
  parseVerdict,
  planBody,
  qaPassed,
  stageLabels,
  verdictBlock,
  type StepResult,
} from './workflow.ts';
import { STEPS, agentsDir, hasWork, isProducer, type AgentsConfig, type Workflow, type Project, type StepId, type Trigger } from './config.ts';
import { runAgent, stopAgents } from './engine.ts';
import { commitsAhead, defaultBranch, ensureDraftPr, ensureWorktree, headSha, markReady, push, resetWorktree, waitForChecks, waitForPrHead } from './git.ts';
import type { Card, Linear } from './linear.ts';
import { recall, vaultPath } from './memory.ts';
import { bootTime, clearCurrent, isPaused, ours, readCurrent, readPending, writeCurrent, writePending, writeRun, type Pending, type RunRecord, type StepRecord } from './state.ts';

const packDir = fileURLToPath(new URL('../pack/', import.meta.url));
const skill = (name: string) => readFileSync(join(packDir, name, 'SKILL.md'), 'utf8');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

class Park extends Error {}

export interface RunContext {
  configDir: string;
  config: AgentsConfig;
  linear: Linear;
  log: (line: string) => void;
  // How to run this CLI again, for `vsf memory recall`.
  selfCommand: string[];
}

function withLabels(card: Card, drop: (l: string) => boolean, add: string[]): string[] {
  return [...new Set([...card.labels.filter((l) => !drop(l)), ...add])];
}


const UNATTENDED = `# Running unattended

You are one step in a workflow. Nobody can answer questions and the
Linear connection is not available: the card and any plan are included above.
Do not write plan files; return your output as your final message. Make the
call the code supports and state it.`;

// Agents keep the memory vault the way you do: durable learnings become notes.
const memoryNote = (vault: string) => `# Memory

The memory vault is \`${vault}\`. If you learn something durable that a later
run should know (how to run the tests, something broken on the base branch, a
trap in this code), save it there as a note: follow \`${vault}/CONVENTIONS.md\`
and add the note's line to \`${vault}/INDEX.md\`. Update a note in place
rather than adding a second one. Skip it when nothing durable came up.`;

// First three non-empty lines of what an agent reported, for run.json.
export function summarize(output: string): string {
  return output.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ').slice(0, 300);
}

// The run in progress, so a cancel signal can mark it.
let active: { record: RunRecord; runDir: string } | null = null;

const isVerdict = (s: StepId) => STEPS[s].output === 'verdict';

// One card through a trigger's workflow. Steps run in order. A failed check (or a
// run of consecutive checks) sends its findings back to the nearest earlier
// step that produces something, Plan or Dev, and the workflow continues from
// there, until everything passes or the loop cap parks the card.
export async function runCard(card: Card, trigger: Trigger, workflowName: string, workflow: Workflow, project: Project, rc: RunContext, opts: { from?: StepId } = {}): Promise<'verified' | 'changes' | 'parked'> {
  const { linear, config, log } = rc;
  const runDir = join(agentsDir(rc.configDir), 'runs', card.identifier, stamp());
  mkdirSync(runDir, { recursive: true });
  const say = (line: string) => log(`${card.identifier} ${line}`);
  const steps = workflow.steps;
  const startedAt = new Date().toISOString();
  const record: RunRecord = { card: card.identifier, title: card.title, url: card.url, workflow: workflowName, trigger: trigger.label, steps: [], outcome: 'running', startedAt };
  active = { record, runDir };
  const save = () => writeRun(runDir, record);
  save();
  let loops = 0;
  // The lock tells status and cancel what is running.
  const mark = (step: string) => writeCurrent(rc.configDir, { pid: process.pid, card: card.identifier, title: card.title, workflow: workflowName, step, round: loops, startedAt, runDir });
  // Written before the first Linear call, so a cancel always knows the card.
  mark('Starting');
  const begin = (step: StepId): StepRecord => {
    const rec: StepRecord = { step, label: STEPS[step].label, startedAt: new Date().toISOString() };
    record.steps.push(rec);
    mark(rec.label);
    save();
    return rec;
  };
  const end = (rec: StepRecord, result: string, output?: string, logFile?: string) => {
    rec.endedAt = new Date().toISOString();
    rec.result = result;
    if (output !== undefined) rec.summary = summarize(output);
    if (logFile) rec.log = basename(logFile);
    save();
  };
  const done = <T extends 'verified' | 'changes' | 'parked'>(outcome: T, reason?: string): T => {
    record.outcome = outcome;
    if (reason) record.reason = reason;
    record.endedAt = new Date().toISOString();
    save();
    return outcome;
  };

  // Shown on the card as the version label and in the lock as the round.
  const setRound = (n: number) => {
    loops = n;
  };
  const stage = (name: string, round?: number) => linear.setLabels(card, stageLabels(card.labels, trigger.label, name, round));
  // Linear hears from the runner twice: the plan once it has passed review,
  // and one final comment. Findings stay here until the final one.
  let lastFindings = '';
  let planToPost: string | null = null;
  const postPlan = async () => {
    if (planToPost === null) return;
    await linear.comment(card, `${PLAN_HEADING}\n\n${planToPost}`);
    planToPost = null;
  };

  async function park(reason: string): Promise<'parked'> {
    say(`parked: ${reason}`);
    const comment = `**Parked:** ${reason}${lastFindings ? `\n\n${lastFindings}` : ''}\n\nFix the cause, then add \`${trigger.label}\` again to retry.`;
    const add = [LABELS.parked, ...(loops ? [LABELS.version(loops)] : [])];
    let commented = false;
    try {
      await postPlan();
      await linear.comment(card, comment);
      commented = true;
      await linear.setLabels(card, stageLabels(card.labels, trigger.label, LABELS.parked, loops || undefined));
    } catch (err) {
      say(`could not reach Linear to park it (${(err as Error).message}). Will retry next minute.`);
      // An empty comment is skipped on retry, so it is not posted twice.
      writePending(rc.configDir, [...readPending(rc.configDir), { card: card.identifier, comment: commented ? '' : comment, drop: [trigger.label], add, dropStatus: true }]);
    }
    return done('parked', reason);
  }

  try {
    if (!existsSync(join(project.path, '.git'))) throw new Park(`The project folder ${project.path} is not a git repository on this Mac.`);
    const from = opts.from ? steps.indexOf(opts.from) : 0;
    if (from < 0) throw new Park(`Workflow ${workflowName} has no ${STEPS[opts.from!].label} step.`);
    let plan = latestPlan(await linear.comments(card.identifier));
    const firstPlan = steps.indexOf('vs-plan', from);
    const needsPlan = steps.findIndex((s, n) => n >= from && (s === 'vs-dev' || s === 'vs-plan-review'));
    if (!plan && needsPlan >= 0 && (firstPlan < 0 || firstPlan > needsPlan)) {
      throw new Park('No plan comment (starting with "## Plan") was found. Publish a plan first, or start the workflow with Plan.');
    }

    await stage(LABELS.stage[steps[from]!]!);
    const base = project.base || defaultBranch(project.path);
    const vault = vaultPath(rc.configDir);
    const known = [recall(rc.selfCommand, rc.configDir, `${workflow.project} ${card.title}\n${card.description ?? ''}`), vault ? memoryNote(vault) : ''].filter(Boolean).join('\n\n');
    const worktree = join(agentsDir(rc.configDir), 'worktrees', card.identifier);
    ensureWorktree(project.path, worktree, card.branchName, base);
    say(`working in ${worktree} on ${card.branchName}`);

    const findings = new Map<number, string>();
    const runs = { plan: 0, dev: 0 };
    let prUrl = '';
    let logs = 0;
    const planText = () => plan ?? '(No plan was posted on this card. Check the work against the card itself.)';
    const timeoutMs = config.timeoutMinutes * 60_000;
    const logFile = (name: string) => join(runDir, `${String(logs++).padStart(2, '0')}-${name}.log`);

    async function check(step: StepId, round: number): Promise<StepResult> {
      const label = STEPS[step].label;
      const rec = begin(step);
      let ciNote = '';
      if (step === 'vs-qa') {
        if (commitsAhead(worktree, base) === 0) {
          end(rec, 'SKIP', 'No changes on the branch yet.');
          return { step: label, verdict: 'SKIP', report: 'No changes on the branch yet.' };
        }
        // CI first, without an agent: a red build goes straight back. Only
        // checks for the commit just pushed count, never an older push's.
        if (prUrl) {
          const sha = headSha(worktree);
          if (!(await waitForPrHead(worktree, card.branchName, sha))) {
            throw new Park(`GitHub never showed commit ${sha.slice(0, 9)} on the pull request, so its CI could not be read. PR: ${prUrl}`);
          }
          const ci = await waitForChecks(worktree, card.branchName);
          if (ci.verdict === 'FIX') {
            end(rec, 'FIX', ci.report);
            return { step: label, verdict: 'FIX', report: ci.report };
          }
          ciNote = ci.verdict === 'SHIP' ? '# CI\n\nCI passed on this branch.' : '# CI\n\nThis repo has no CI checks.';
        }
      }
      const log = logFile(step);
      const r = await runAgent({
        engine: config.engine, model: config.models.review, cwd: worktree, vault, write: step === 'vs-qa', logFile: log, timeoutMs,
        prompt: buildPrompt({ skill: skill(step), card, plan: planText(), base, round, extra: [known, ciNote, UNATTENDED].filter(Boolean).join('\n\n') }),
      });
      if (step === 'vs-qa') resetWorktree(worktree);
      const verdict = parseVerdict(r.output);
      end(rec, verdict, r.output, log);
      return { step: label, verdict, report: r.output };
    }

    let i = from;
    while (i < steps.length) {
      const step = steps[i]!;
      say(`${STEPS[step].label}`);

      if (isVerdict(step)) {
        const [start, end] = verdictBlock(steps, i, isVerdict);
        const target = fixTarget(steps, start, isProducer);
        const producer = target >= 0 ? steps[target] : undefined;
        // The round being checked: how many times its producer has run.
        const round = Math.max(producer === 'vs-plan' ? runs.plan : runs.dev, 1);
        setRound(round);
        const results: StepResult[] = [];
        for (const s of steps.slice(start, end)) {
          await stage(LABELS.stage[s]!, round);
          results.push(await check(s, round));
        }
        if (qaPassed(results)) {
          i = end;
          continue;
        }
        const notes = findingsFor(results);
        lastFindings = `**Latest findings (round ${round}).**\n\n${notes}`;
        if (target < 0) {
          await postPlan();
          await linear.comment(card, `**Changes needed.**\n\n${notes}`);
          await linear.setLabels(card, stageLabels(card.labels, trigger.label, LABELS.changes, round));
          say('changes requested');
          return done('changes');
        }
        // Rounds caps how many times Plan or Dev runs, counting the first.
        if (round >= workflow.maxRounds) {
          throw new Park(`Checks still failed after ${round} ${producer === 'vs-plan' ? 'plan' : 'dev'} rounds.${prUrl ? ` PR: ${prUrl}` : ''}`);
        }
        findings.set(target, notes);
        i = target;
        continue;
      }

      if (step === 'vs-plan') {
        setRound(runs.plan + 1);
        await stage(LABELS.stage[step]!, runs.plan + 1);
        const rec = begin(step);
        const log = logFile('plan');
        const r = await runAgent({
          engine: config.engine, model: config.models.dev, cwd: worktree, vault, write: false, logFile: log, timeoutMs,
          prompt: buildPrompt({ skill: skill('vs-plan'), card, plan: plan ?? '(none yet, you are writing it)', base, round: runs.plan + 1, findings: findings.get(i), extra: [known, UNATTENDED].filter(Boolean).join('\n\n') }),
        });
        const result = parseDevResult(r.output);
        end(rec, result.status === 'blocked' ? 'blocked' : 'done', r.output, log);
        if (result.status === 'blocked') throw new Park(`The plan agent stopped: ${result.reason}`);
        plan = planBody(r.output);
        planToPost = plan;
        runs.plan++;
      } else if (step === 'vs-publish') {
        await postPlan();
        const rec = begin(step);
        push(worktree, card.branchName);
        end(rec, 'pushed');
      } else if (step === 'vs-dev') {
        await postPlan();
        setRound(runs.dev + 1);
        await stage(LABELS.stage[step]!, runs.dev + 1);
        const rec = begin(step);
        const log = logFile('dev');
        const before = headSha(worktree);
        const dev = await runAgent({
          engine: config.engine, model: config.models.dev, cwd: worktree, vault, write: true, logFile: log, timeoutMs,
          prompt: buildPrompt({ skill: skill('vs-dev'), card, plan: planText(), base, round: runs.dev + 1, findings: findings.get(i), extra: [known, UNATTENDED].filter(Boolean).join('\n\n') }),
        });
        const result = parseDevResult(dev.output);
        end(rec, result.status === 'blocked' ? 'blocked' : 'done', dev.output, log);
        if (result.status === 'blocked') throw new Park(`The dev agent stopped: ${result.reason}`);
        if (commitsAhead(worktree, base) === 0) throw new Park('The dev agent made no commits.');
        // A round sent back with findings must change something, or QA would
        // just check the same commit again.
        if (runs.dev > 0 && headSha(worktree) === before) throw new Park('The dev agent made no new commits this round.');
        push(worktree, card.branchName);
        prUrl = ensureDraftPr(worktree, card.branchName, base, `${card.identifier}: ${card.title}`, card.url);
        record.prUrl = prUrl;
        save();
        runs.dev++;
      }
      findings.delete(i);
      i++;
    }

    await postPlan();
    let moved = false;
    if (hasWork(workflow)) {
      markReady(worktree, card.branchName);
      moved = await linear.moveTo(card, config.reviewState);
    }
    await linear.setLabels(card, stageLabels(card.labels, trigger.label, LABELS.verified, loops || undefined));
    await linear.comment(card, `**All checks passed.**${prUrl ? ` PR ready: ${prUrl}` : ''}${hasWork(workflow) && !moved ? `\n\n(No "${config.reviewState}" state on this team, so the card was not moved.)` : ''}`);
    say('verified');
    return done('verified');
  } catch (err) {
    if (err instanceof Park) return park(err.message);
    return park(`Something went wrong: ${(err as Error).message}`);
  } finally {
    active = null;
  }
}

// The first card waiting on any workflow's triggers, in workflow order.
// With a workflow name, only that workflow is considered.
export async function nextJob(rc: RunContext, only?: string, workflowName?: string): Promise<{ card: Card; trigger: Trigger; workflow: string } | null> {
  const pinned = only ? await rc.linear.card(only) : null;
  for (const [name, workflow] of Object.entries(rc.config.workflows)) {
    if (workflowName && name !== workflowName) continue;
    for (const trigger of workflow.triggers) {
      const cards = pinned ? [pinned] : await rc.linear.myCardsWithLabel(trigger.label);
      // A pinned card may have lost its label (a parked card re-run by hand), so match by team.
      const card = cards.find((c) => c.teamKey === trigger.team && (pinned || c.labels.includes(trigger.label)));
      if (card) return { card, trigger, workflow: name };
    }
  }
  return null;
}

// Retries Linear writes that failed while parking. Never throws.
async function flushPending(rc: RunContext): Promise<void> {
  const left: Pending[] = [];
  for (const p of readPending(rc.configDir)) {
    try {
      const card = await rc.linear.card(p.card);
      if (p.comment) {
        await rc.linear.comment(card, p.comment);
        p.comment = '';
      }
      await rc.linear.setLabels(card, withLabels(card, (l) => p.drop.includes(l) || (!!p.dropStatus && isStatusLabel(l)), p.add));
    } catch {
      left.push(p);
    }
  }
  try {
    writePending(rc.configDir, left);
  } catch {
    // nothing more to do
  }
}

// Takes the working label off a cancelled card and says so. When Linear
// cannot be reached the same change is queued for the next tick.
export async function cancelCard(linear: Linear, configDir: string, cardId: string, label: string): Promise<boolean> {
  const comment = `**Cancelled.** Add \`${label}\` again to restart.`;
  try {
    const card = await linear.card(cardId);
    await linear.setLabels(card, withLabels(card, isStatusLabel, []));
    await linear.comment(card, comment);
    return true;
  } catch {
    queueCancel(configDir, cardId, comment);
    return false;
  }
}

function queueCancel(configDir: string, cardId: string, comment: string): void {
  const pending = readPending(configDir);
  if (pending.some((p) => p.card === cardId && p.comment === comment)) return;
  try {
    writePending(configDir, [...pending, { card: cardId, comment, drop: [], add: [], dropStatus: true }]);
  } catch {
    // nothing more to do
  }
}

// One pass for the background runner. A lock keeps two passes from working at once.
export async function tick(rc: RunContext, only?: string, opts: { workflow?: string; from?: StepId } = {}): Promise<number> {
  const held = readCurrent(rc.configDir);
  const booted = bootTime();
  // A lock from before the last boot cannot be a live run, whatever its pid is now.
  const fromBeforeBoot = !!(held?.startedAt && booted && new Date(held.startedAt) < booted);
  if (held && held.pid !== process.pid && !fromBeforeBoot && ours(held.pid)) {
    if (only) rc.log(`The runner is busy with ${held.card ?? 'a check'}. Try again when it finishes.`);
    return only ? 1 : 0;
  }
  writeCurrent(rc.configDir, { pid: process.pid, startedAt: new Date().toISOString() });
  // A stop (Ctrl+C, launchd, shutdown) ends the agents, marks the run, and
  // takes the working label off the card so it is never left stuck.
  const onSignal = async () => {
    await stopAgents();
    const running = active && active.record.outcome === 'running' ? active : null;
    if (active) {
      active.record.outcome = 'cancelled';
      active.record.endedAt = new Date().toISOString();
      try {
        writeRun(active.runDir, active.record);
      } catch {
        // the run folder is gone
      }
    }
    if (running) {
      const { card, trigger } = running.record;
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000).unref());
      const finished = await Promise.race([cancelCard(rc.linear, rc.configDir, card, trigger), timeout]);
      // Did not finish in time: leave the work for the next tick.
      if (!finished) queueCancel(rc.configDir, card, `**Cancelled.** Add \`${trigger}\` again to restart.`);
    }
    clearCurrent(rc.configDir);
    process.exit(143);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await flushPending(rc);
    if (!only && isPaused(rc.configDir)) return 0;
    let job: Awaited<ReturnType<typeof nextJob>>;
    try {
      job = await nextJob(rc, only, opts.workflow);
    } catch (err) {
      rc.log(`Could not check Linear (${(err as Error).message}). Trying again next minute.`);
      return 1;
    }
    if (!job) {
      if (only) rc.log(`${only} starts no workflow: it needs a workflow's team and label.`);
      return only ? 1 : 0;
    }
    const workflow = rc.config.workflows[job.workflow]!;
    const project = rc.config.projects[workflow.project];
    if (!project) {
      rc.log(`Workflow ${job.workflow} points at a missing project ${workflow.project}. Run vsf agents workflow edit to fix it.`);
      return 1;
    }
    if (opts.from && !workflow.steps.includes(opts.from)) {
      rc.log(`Workflow ${job.workflow} has no ${STEPS[opts.from].label} step.`);
      return 2;
    }
    const outcome = await runCard(job.card, job.trigger, job.workflow, workflow, project, rc, { from: opts.from });
    return outcome === 'verified' ? 0 : 1;
  } catch (err) {
    rc.log(`Error: ${(err as Error).message}`);
    return 1;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    clearCurrent(rc.configDir);
  }
}
