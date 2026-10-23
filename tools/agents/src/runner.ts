import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  LABELS,
  PLAN_HEADING,
  buildPrompt,
  findingsFor,
  fixTarget,
  isStatusLabel,
  latestPlan,
  needsPlan,
  parseDevResult,
  parseVerdict,
  planBody,
  qaPassed,
  stageLabels,
  verdictBlock,
  type StepResult,
} from './workflow.ts';
import { agentsDir, hasWork, isCardTrigger, resolveProject, resolveStep, stepId, stepIdLabel, workspaceContext, workspaceOf, type AgentsConfig, type ResolvedStep, type Workflow, type Project, type Trigger } from './config.ts';
import { lastDue, parseCron } from './cron.ts';
import { runAgent, stopAgents } from './engine.ts';
import { commitsAhead, enforceCommitPolicy, defaultBranch, ensureDraftPr, ensureWorktree, headSha, markReady, push, resetWorktree, waitForChecks, waitForPrHead } from './git.ts';
import type { Card } from './linear.ts';
import { noTracker, type Tracker, type Trackers } from './tracker.ts';
import { recall, syncMemory, vaultPath } from './memory.ts';
import { claudeSettingsFile, readRules, rulesSection } from './profile.ts';
import { acquireWorkspace, clearCurrent, heldByOther, isPaused, liveRuns, readCurrent, readPending, releaseWorkspace, writeCurrent, writePending, writeRun, writeWorkspace, readCronState, writeCronState, type Pending, type RunRecord, type StepRecord } from './state.ts';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

class Park extends Error {}

export interface RunContext {
  configDir: string;
  config: AgentsConfig;
  trackers: Trackers;
  log: (line: string) => void;
  // How to run this CLI again, for `vsf memory recall`.
  selfCommand: string[];
}

function withLabels(card: Card, drop: (l: string) => boolean, add: string[]): string[] {
  return [...new Set([...card.labels.filter((l) => !drop(l)), ...add])];
}


const UNATTENDED = `# Running unattended

You are one step in a workflow. Nobody can answer questions and the
tracker connection is not available: the card and any plan are included above.
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

const isVerdict = (d: ResolvedStep) => d.output === 'verdict';
const isProducer = (d: ResolvedStep) => d.output === 'plan' || d.output === 'commits';
// The card label for a step: its own for a built-in step, a generic one otherwise.
const stageOf = (d: ResolvedStep) => LABELS.stage[d.builtin ?? ''] ?? LABELS.working;

// One card through a trigger's workflow. Steps run in order. A failed check (or a
// run of consecutive checks) sends its findings back to the nearest earlier
// step that produces something, Plan or Dev, and the workflow continues from
// there, until everything passes or the loop cap parks the card.
export async function runCard(card: Card, trigger: Trigger, workflowName: string, workflow: Workflow, project: Project, rc: RunContext, opts: { from?: string } = {}): Promise<'verified' | 'changes' | 'parked'> {
  const { config, log } = rc;
  // A scheduled run has no card, so it has nothing to write back to.
  const linear: Tracker = isCardTrigger(trigger) ? rc.trackers(trigger.source) : noTracker;
  const label = isCardTrigger(trigger) ? trigger.label : '';
  const runDir = join(agentsDir(rc.configDir), 'runs', card.identifier, stamp());
  mkdirSync(runDir, { recursive: true });
  const say = (line: string) => log(`${card.identifier} ${line}`);
  // Write back settings apply to card runs; a scheduled run has nothing to write to.
  const writeBack = isCardTrigger(trigger) ? (workflow.writeBack ?? {}) : {};
  const labelsOn = writeBack.labels !== false;
  const startedAt = new Date().toISOString();
  const workspace = workspaceOf(project);
  const record: RunRecord = { card: card.identifier, title: card.title, url: card.url || undefined, workflow: workflowName, trigger: label || (trigger.source === 'cron' ? trigger.schedule : ''), source: trigger.source, steps: [], outcome: 'running', workspace, startedAt };
  active = { record, runDir };
  const save = () => writeRun(runDir, record);
  save();
  let loops = 0;
  // The workspace lock tells status and cancel what is running.
  const mark = (step: string) => writeWorkspace(rc.configDir, workspace, { pid: process.pid, card: card.identifier, title: card.title, workflow: workflowName, step, round: loops, startedAt, runDir, source: trigger.source });
  // Written before the first tracker call, so a cancel always knows the card.
  mark('Starting');
  const begin = (def: ResolvedStep): StepRecord => {
    const rec: StepRecord = { step: def.id, label: def.label, startedAt: new Date().toISOString() };
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
  const stage = async (name: string, round?: number) => {
    if (labelsOn) await linear.setLabels(card, stageLabels(card.labels, label, name, round));
  };
  // How a run ends on the card: a stage label, or with labels off only the
  // trigger taken away so the card is not picked up again.
  const endLabels = (name: string, round?: number) =>
    linear.setLabels(card, labelsOn ? stageLabels(card.labels, label, name, round) : card.labels.filter((l) => l !== label));
  // The tracker hears from the runner twice: the plan once it has passed review,
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
    const comment = `**Parked:** ${reason}${lastFindings ? `\n\n${lastFindings}` : ''}\n\nFix the cause, then add \`${label}\` again to retry.`;
    const add = labelsOn ? [LABELS.parked, ...(loops ? [LABELS.version(loops)] : [])] : [];
    let commented = false;
    try {
      await postPlan();
      await linear.comment(card, comment);
      commented = true;
      await endLabels(LABELS.parked, loops || undefined);
    } catch (err) {
      if (!isCardTrigger(trigger)) return done('parked', reason);
      say(`could not reach ${trigger.source === 'voidtrack' ? 'VoidTrack' : 'Linear'} to park it (${(err as Error).message}). Will retry next minute.`);
      // An empty comment is skipped on retry, so it is not posted twice.
      writePending(rc.configDir, [...readPending(rc.configDir), { card: card.identifier, comment: commented ? '' : comment, drop: [label], add, dropStatus: labelsOn, source: trigger.source }]);
    }
    return done('parked', reason);
  }

  try {
    if (!existsSync(join(project.path, '.git'))) throw new Park(`The project folder ${project.path} is not a git repository on this Mac.`);
    const steps = workflow.steps.map((s) => resolveStep(s, config, config.folders?.[workflowName]));
    const from = opts.from ? steps.findIndex((d) => d.id === opts.from) : 0;
    if (from < 0) throw new Park(`Workflow ${workflowName} has no ${stepIdLabel(opts.from!)} step.`);
    // A scheduled run has no card to plan on, so its task is the plan unless a Plan step writes one.
    let plan = isCardTrigger(trigger) ? latestPlan(await linear.comments(card.identifier)) : card.description ?? null;
    if (!plan && needsPlan(steps, from)) {
      throw new Park('No plan comment (starting with "## Plan") was found. Publish a plan first, or start the workflow with Plan.');
    }

    await stage(stageOf(steps[from]!));
    const base = project.base || defaultBranch(project.path);
    const vault = vaultPath(rc.configDir);
    // Your profile rides along on every step: rules in the prompt, Claude settings as a file.
    let settingsFile: string | undefined;
    try {
      settingsFile = claudeSettingsFile(rc.configDir, runDir);
    } catch (err) {
      throw new Park(`Your agent profile's Claude settings are broken: ${(err as Error).message}`);
    }
    const rules = rulesSection(readRules(rc.configDir));
    // Latest notes from every machine before recall reads them.
    const pulled = syncMemory(rc.selfCommand, rc.configDir);
    if (pulled) say(pulled);
    const context = workspaceContext(config, workspace);
    const known = [recall(rc.selfCommand, rc.configDir, `${workflow.project} ${card.title}\n${card.description ?? ''}`), context ? `# Workspace\n\n${context}` : '', vault ? memoryNote(vault) : '', rules].filter(Boolean).join('\n\n');
    const worktree = join(agentsDir(rc.configDir), 'worktrees', card.identifier);
    ensureWorktree(project.path, worktree, card.branchName, base);
    say(`working in ${worktree} on ${card.branchName}`);

    const findings = new Map<number, string>();
    const runs = { plan: 0, dev: 0 };
    let prUrl = '';
    let logs = 0;
    const planText = () => plan ?? '(No plan was posted on this card. Check the work against the card itself.)';
    const logFile = (name: string) => join(runDir, `${String(logs++).padStart(2, '0')}-${name}.log`);

    async function check(def: ResolvedStep, round: number): Promise<StepResult> {
      const label = def.label;
      const rec = begin(def);
      let ciNote = '';
      if (def.builtin === 'vs-qa') {
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
          // A slow CI is not a failed one: wait a second window, then park
          // rather than send Dev a round it can only answer with no commit.
          let ci = await waitForChecks(worktree, card.branchName);
          if (ci.verdict === 'PENDING') {
            say('CI still running, waiting another window');
            ci = await waitForChecks(worktree, card.branchName);
          }
          if (ci.verdict === 'PENDING') throw new Park(`${ci.report} PR: ${prUrl}`);
          if (ci.verdict === 'FIX') {
            end(rec, 'FIX', ci.report);
            return { step: label, verdict: 'FIX', report: ci.report };
          }
          ciNote = ci.verdict === 'SHIP' ? '# CI\n\nCI passed on this branch.' : '# CI\n\nThis repo has no CI checks.';
        }
      }
      const log = logFile(def.id);
      const r = await runAgent({
        engine: def.engine, model: def.model, cwd: worktree, vault, settingsFile, write: def.write, logFile: log, timeoutMs: def.timeoutMs,
        prompt: buildPrompt({ skill: def.prompt(), card, plan: planText(), base, round, extra: [known, ciNote, UNATTENDED].filter(Boolean).join('\n\n') }),
      });
      if (def.builtin === 'vs-qa') resetWorktree(worktree);
      const verdict = parseVerdict(r.output);
      end(rec, verdict, r.output, log);
      return { step: label, verdict, report: r.output };
    }

    let i = from;
    while (i < steps.length) {
      const def = steps[i]!;
      say(def.label);

      if (isVerdict(def)) {
        const [start, end] = verdictBlock(steps, i, isVerdict);
        const target = fixTarget(steps, start, isProducer);
        const producer = target >= 0 ? steps[target] : undefined;
        // The round being checked: how many times its producer has run.
        const round = Math.max(producer?.output === 'plan' ? runs.plan : runs.dev, 1);
        setRound(round);
        const results: StepResult[] = [];
        for (const s of steps.slice(start, end)) {
          await stage(stageOf(s), round);
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
          await endLabels(LABELS.changes, round);
          say('changes requested');
          return done('changes');
        }
        // Rounds caps how many times Plan or Dev runs, counting the first.
        if (round >= workflow.maxRounds) {
          throw new Park(`Checks still failed after ${round} ${producer?.output === 'plan' ? 'plan' : 'dev'} rounds.${prUrl ? ` PR: ${prUrl}` : ''}`);
        }
        findings.set(target, notes);
        i = target;
        continue;
      }

      if (def.output === 'plan') {
        setRound(runs.plan + 1);
        await stage(stageOf(def), runs.plan + 1);
        const rec = begin(def);
        const log = logFile(def.builtin ? 'plan' : def.id);
        const r = await runAgent({
          engine: def.engine, model: def.model, cwd: worktree, vault, settingsFile, write: def.write, logFile: log, timeoutMs: def.timeoutMs,
          prompt: buildPrompt({ skill: def.prompt(), card, plan: plan ?? '(none yet, you are writing it)', base, round: runs.plan + 1, findings: findings.get(i), extra: [known, UNATTENDED].filter(Boolean).join('\n\n') }),
        });
        const result = parseDevResult(r.output);
        end(rec, result.status === 'blocked' ? 'blocked' : 'done', r.output, log);
        if (result.status === 'blocked') throw new Park(`The plan agent stopped: ${result.reason}`);
        plan = planBody(r.output);
        planToPost = plan;
        runs.plan++;
      } else if (def.output === 'publish') {
        await postPlan();
        const rec = begin(def);
        push(worktree, card.branchName);
        end(rec, 'pushed');
      } else if (def.output === 'commits') {
        await postPlan();
        setRound(runs.dev + 1);
        await stage(stageOf(def), runs.dev + 1);
        const rec = begin(def);
        const log = logFile(def.builtin ? 'dev' : def.id);
        const before = headSha(worktree);
        const dev = await runAgent({
          engine: def.engine, model: def.model, cwd: worktree, vault, settingsFile, write: def.write, logFile: log, timeoutMs: def.timeoutMs,
          prompt: buildPrompt({ skill: def.prompt(), card, plan: planText(), base, round: runs.dev + 1, findings: findings.get(i), extra: [known, UNATTENDED].filter(Boolean).join('\n\n') }),
        });
        const result = parseDevResult(dev.output);
        end(rec, result.status === 'blocked' ? 'blocked' : 'done', dev.output, log);
        if (result.status === 'blocked') throw new Park(`The dev agent stopped: ${result.reason}`);
        if (commitsAhead(worktree, base) === 0) throw new Park('The dev agent made no commits.');
        // A round sent back with findings must change something, or QA would
        // just check the same commit again.
        if (runs.dev > 0 && headSha(worktree) === before) throw new Park('The dev agent made no new commits this round.');
        // Only this round's commits, which are not pushed yet.
        const fixed = enforceCommitPolicy(worktree, before, config.commits ?? {});
        if (fixed) say(`applied the commit policy to ${fixed} commit${fixed === 1 ? '' : 's'}`);
        push(worktree, card.branchName);
        prUrl = ensureDraftPr(worktree, card.branchName, base, `${card.identifier}: ${card.title}`, card.url);
        record.prUrl = prUrl;
        save();
        runs.dev++;
      } else {
        // A step with no output the workflow reads: it runs once and must finish.
        await stage(stageOf(def), loops || undefined);
        const rec = begin(def);
        const log = logFile(def.id);
        const r = await runAgent({
          engine: def.engine, model: def.model, cwd: worktree, vault, settingsFile, write: def.write, logFile: log, timeoutMs: def.timeoutMs,
          prompt: buildPrompt({ skill: def.prompt(), card, plan: plan ?? '(none)', base, round: loops || 1, extra: [known, UNATTENDED].filter(Boolean).join('\n\n') }),
        });
        end(rec, r.ok ? 'done' : 'failed', r.output, log);
        if (!r.ok) throw new Park(`The ${def.label} step failed or timed out.`);
      }
      findings.delete(i);
      i++;
    }

    await postPlan();
    // Unset moves a card with commits to reviewState; a state always moves it; null never does.
    const state = writeBack.state === undefined ? (hasWork(workflow) ? config.reviewState : null) : writeBack.state;
    if (hasWork(workflow)) markReady(worktree, card.branchName);
    const moved = state ? await linear.moveTo(card, state) : true;
    await endLabels(LABELS.verified, loops || undefined);
    if (writeBack.comment !== false) {
      await linear.comment(card, `**All checks passed.**${prUrl ? ` PR ready: ${prUrl}` : ''}${!moved ? `\n\n(No "${state}" state on this team, so the card was not moved.)` : ''}`);
    }
    say('verified');
    return done('verified');
  } catch (err) {
    if (err instanceof Park) return park(err.message);
    return park(`Something went wrong: ${(err as Error).message}`);
  } finally {
    active = null;
    // Share whatever notes the agents wrote, whatever the outcome.
    const shared = syncMemory(rc.selfCommand, rc.configDir);
    if (shared) say(shared);
  }
}

type Job = { card: Card; trigger: Trigger; workflow: string; workspace: string };

// The workspace whose queue a job waits in. A workflow whose project is
// missing still queues somewhere, so its run can say what is wrong.
const jobWorkspace = (config: AgentsConfig, workflow: Workflow, card: Card) => workspaceOf(resolveProject(config, workflow, card)?.project);

export function cronCard(workflow: string, task: string, at: Date): Card {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const slug = workflow.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cron';
  return {
    id: '',
    identifier: `${slug.replace(/-/g, '').toUpperCase()}-${stamp}`,
    title: task.split('\n')[0]!.slice(0, 80),
    description: task,
    url: '',
    branchName: `vs/${slug}-${stamp}`,
    teamId: '',
    teamKey: '',
    labels: [],
  };
}

const cronKey = (workflow: string, schedule: string) => `${workflow} ${schedule}`;

export interface JobQuery {
  // Only this card, matched by team whatever its labels.
  only?: string;
  // Only this workflow; `force` fires its schedule now.
  workflow?: string;
  // Only this schedule of the workflow.
  schedule?: string;
  force?: boolean;
  // Workspaces whose queue is taken: their jobs wait.
  busy?: Set<string>;
  // Cards to leave for later.
  skip?: Set<string>;
  // How many jobs to return, at most one per workspace.
  limit?: number;
  now?: Date;
}

// Jobs waiting on the workflows' triggers, in workflow order, at most one per
// workspace and none in a busy one: a card carrying a trigger label, or a
// schedule that came due since it last fired. A schedule seen for the first
// time starts counting from now, and one whose workspace is busy keeps waiting
// without being marked as fired.
export async function findJobs(rc: RunContext, q: JobQuery = {}): Promise<Job[]> {
  const now = q.now ?? new Date();
  const limit = q.limit ?? Infinity;
  const taken = new Set(q.busy ?? []);
  const out: Job[] = [];
  const workflows = Object.entries(rc.config.workflows).filter(([name]) => !q.workflow || name === q.workflow);
  let pinned: { card: Card; source: string } | null = null;
  if (q.only) {
    const team = q.only.split('-')[0]!.toUpperCase();
    const sources = [...new Set(workflows.flatMap(([, w]) => w.triggers.filter(isCardTrigger).filter((t) => t.team === team).map((t) => t.source)))];
    for (const source of sources) {
      try {
        pinned = { card: await rc.trackers(source).card(q.only), source };
        break;
      } catch (err) {
        if (source === sources.at(-1)) throw err;
      }
    }
    if (!pinned) return [];
  }
  const cron = readCronState(rc.configDir);
  let cronChanged = false;
  const take = (job: Omit<Job, 'workspace'>, workspace: string) => {
    taken.add(workspace);
    out.push({ ...job, workspace });
    return out.length >= limit;
  };
  try {
    for (const [name, workflow] of workflows) {
      for (const trigger of workflow.triggers) {
        if (!isCardTrigger(trigger)) {
          const schedule = q.only || (q.schedule && q.schedule !== trigger.schedule) ? null : parseCron(trigger.schedule);
          if (!schedule) continue;
          const key = cronKey(name, trigger.schedule);
          const last = cron[key];
          if (!last) {
            cron[key] = now.toISOString();
            cronChanged = true;
          }
          const due = q.force ? now : last ? lastDue(schedule, new Date(last), now) : null;
          if (!due) continue;
          const card = cronCard(name, trigger.task, due);
          const workspace = jobWorkspace(rc.config, workflow, card);
          if (taken.has(workspace)) continue;
          cron[key] = now.toISOString();
          cronChanged = true;
          if (take({ card, trigger, workflow: name }, workspace)) return out;
          continue;
        }
        // A pinned card may have lost its label (a parked card re-run by hand), so match by team.
        if (pinned) {
          if (pinned.source === trigger.source && pinned.card.teamKey === trigger.team) {
            take({ card: pinned.card, trigger, workflow: name }, jobWorkspace(rc.config, workflow, pinned.card));
            return out;
          }
          continue;
        }
        let cards: Card[];
        try {
          cards = await rc.trackers(trigger.source).myCardsWithLabel(trigger.label, trigger.team);
        } catch (err) {
          // One tracker being down or unset must not stop the others.
          rc.log(`Could not check ${trigger.source === 'voidtrack' ? 'VoidTrack' : 'Linear'} for ${trigger.team} + ${trigger.label} (${(err as Error).message}). Trying again next minute.`);
          continue;
        }
        for (const card of cards) {
          if (card.teamKey !== trigger.team || !card.labels.includes(trigger.label)) continue;
          // A card already taken this pass, by an earlier trigger, is not run twice.
          if (q.skip?.has(card.identifier) || out.some((j) => j.card.identifier === card.identifier)) continue;
          const workspace = jobWorkspace(rc.config, workflow, card);
          if (taken.has(workspace)) continue;
          if (take({ card, trigger, workflow: name }, workspace)) return out;
        }
      }
    }
    return out;
  } finally {
    if (cronChanged) writeCronState(rc.configDir, cron);
  }
}

// The first job waiting, as findJobs finds it. With a card, only that card is
// considered; with a workflow name, only that workflow, and `force` fires its
// schedule now.
export async function nextJob(rc: RunContext, only?: string, workflowName?: string, opts: Omit<JobQuery, 'only' | 'workflow' | 'limit'> = {}): Promise<Job | null> {
  return (await findJobs(rc, { ...opts, only, workflow: workflowName, limit: 1 }))[0] ?? null;
}

// Retries tracker writes that failed while parking. Never throws.
async function flushPending(rc: RunContext): Promise<void> {
  const left: Pending[] = [];
  for (const p of readPending(rc.configDir)) {
    try {
      const tracker = rc.trackers(p.source ?? 'linear');
      const card = await tracker.card(p.card);
      if (p.comment) {
        await tracker.comment(card, p.comment);
        p.comment = '';
      }
      await tracker.setLabels(card, withLabels(card, (l) => p.drop.includes(l) || (!!p.dropStatus && isStatusLabel(l)), p.add));
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

// Takes the working label off a cancelled card and says so. When the tracker
// cannot be reached the same change is queued for the next tick.
export async function cancelCard(tracker: Tracker, configDir: string, cardId: string, label: string, source: 'linear' | 'voidtrack' = 'linear'): Promise<boolean> {
  const comment = `**Cancelled.** Add \`${label}\` again to restart.`;
  try {
    const card = await tracker.card(cardId);
    await tracker.setLabels(card, withLabels(card, isStatusLabel, []));
    await tracker.comment(card, comment);
    return true;
  } catch {
    queueCancel(configDir, cardId, comment, source);
    return false;
  }
}

function queueCancel(configDir: string, cardId: string, comment: string, source: 'linear' | 'voidtrack' = 'linear'): void {
  const pending = readPending(configDir);
  if (pending.some((p) => p.card === cardId && p.comment === comment)) return;
  try {
    writePending(configDir, [...pending, { card: cardId, comment, drop: [], add: [], dropStatus: true, source }]);
  } catch {
    // nothing more to do
  }
}

// Runs one job in its workspace's queue: a pinned card, a workflow's schedule,
// or the first job waiting in a free workspace. The workspace lock keeps two
// runs from working in one workspace at once. `child` is a run the dispatcher
// started, which leaves the pending writes to it.
export async function tick(rc: RunContext, only?: string, opts: { workflow?: string; from?: string; schedule?: string; child?: boolean } = {}): Promise<number> {
  let held: string | null = null;
  // A stop (Ctrl+C, the dispatcher, launchd, shutdown) ends the agents, marks
  // the run, and takes the working label off the card so it is never left stuck.
  // The dispatcher and the service can both signal, so a second one is ignored.
  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
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
    if (running && running.record.source !== 'cron') {
      const { card, trigger } = running.record;
      const source = running.record.source ?? 'linear';
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000).unref());
      const work = (async () => cancelCard(rc.trackers(source), rc.configDir, card, trigger, source))().catch(() => false);
      const finished = await Promise.race([work, timeout]);
      // Did not finish in time: leave the work for the next tick.
      if (!finished) queueCancel(rc.configDir, card, `**Cancelled.** Add \`${trigger}\` again to restart.`, source);
    }
    if (held) releaseWorkspace(rc.configDir, held);
    process.exit(143);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    if (!opts.child) await flushPending(rc);
    if (!only && isPaused(rc.configDir)) return 0;
    let job: Job | null;
    try {
      const busy = only ? undefined : new Set(liveRuns(rc.configDir).filter((c) => c.pid !== process.pid).map((c) => workspaceOf(c)));
      job = await nextJob(rc, only, opts.workflow, { force: !!opts.workflow && !only, schedule: opts.schedule, busy });
    } catch (err) {
      rc.log(`Could not read ${only} (${(err as Error).message}).`);
      return 1;
    }
    if (!job) {
      if (only) rc.log(`${only} starts no workflow: it needs a workflow's team and label.`);
      return only ? 1 : 0;
    }
    const workflow = rc.config.workflows[job.workflow]!;
    const resolved = resolveProject(rc.config, workflow, job.card);
    if (!resolved) {
      rc.log(`Workflow ${job.workflow} points at a missing project ${workflow.project}. Run vsf agents workflow edit to fix it.`);
      return 1;
    }
    if (opts.from && !workflow.steps.some((s) => stepId(s) === opts.from)) {
      rc.log(`Workflow ${job.workflow} has no ${stepIdLabel(opts.from)} step.`);
      return 2;
    }
    const busy = acquireWorkspace(rc.configDir, job.workspace, { pid: process.pid, card: job.card.identifier, startedAt: new Date().toISOString() });
    if (busy) {
      rc.log(`Workspace ${job.workspace} is busy with ${busy.card ?? 'a check'}. Try again when it finishes.`);
      return 1;
    }
    held = job.workspace;
    const outcome = await runCard(job.card, job.trigger, job.workflow, workflow, resolved.project, rc, { from: opts.from });
    return outcome === 'verified' ? 0 : 1;
  } catch (err) {
    rc.log(`Error: ${(err as Error).message}`);
    return 1;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (held) releaseWorkspace(rc.configDir, held);
  }
}

// A run the dispatcher started, as much of a child process as it needs.
export interface ChildRun {
  kill(signal: NodeJS.Signals): unknown;
  once(event: 'exit' | 'error', listener: (err?: Error) => void): unknown;
  exitCode: number | null;
}

export interface DispatchDeps {
  // Starts `agents tick` with these arguments in a process of its own.
  start: (args: string[]) => ChildRun;
  // How long to wait for a run to finish before looking for work again.
  waitMs: number;
  // The config as it is now, read again on every pass.
  reload?: () => AgentsConfig;
}

// The arguments that make a child tick run exactly this job.
export const jobArgs = (job: Job): string[] =>
  isCardTrigger(job.trigger) ? ['--card', job.card.identifier, '--workflow', job.workflow] : ['--workflow', job.workflow, '--schedule', job.trigger.schedule];

const realDeps = (rc: RunContext): DispatchDeps => ({
  start: (args) => {
    const [bin, ...rest] = rc.selfCommand;
    return spawn(bin!, [...rest, 'agents', 'tick', ...args], { stdio: 'inherit' });
  },
  waitMs: 60_000,
});

// The background runner. The service starts a new pass only once the last one
// ended, so this pass stays up while cards run: it starts one child process
// per workspace with work waiting, looks again whenever one ends or a minute
// passes, and returns once nothing runs and nothing waits. runner.lock keeps
// two dispatchers from working at once.
export async function dispatch(rc: RunContext, over: Partial<DispatchDeps> = {}): Promise<number> {
  const deps = { ...realDeps(rc), ...over };
  const held = readCurrent(rc.configDir);
  if (held && heldByOther(held)) return 0;
  writeCurrent(rc.configDir, { pid: process.pid, startedAt: new Date().toISOString() });
  const children = new Map<string, ChildRun>();
  // When each card was started, so one whose run failed before it took the
  // trigger label off waits for the next pass instead of starting again at once.
  const started = new Map<string, number>();
  // Ends the wait early when a child exits.
  let wake = () => {};
  // A stop ends every run: each child cancels its own card.
  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    const exits = [...children.values()].filter((c) => c.exitCode === null).map((c) => new Promise<void>((resolve) => c.once('exit', () => resolve())));
    for (const c of children.values()) c.kill('SIGTERM');
    await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    clearCurrent(rc.configDir);
    process.exit(143);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    for (;;) {
      if (deps.reload) rc = { ...rc, config: deps.reload() };
      await flushPending(rc);
      if (!isPaused(rc.configDir)) {
        const busy = new Set([...children.keys(), ...liveRuns(rc.configDir).map((c) => workspaceOf(c))]);
        const skip = new Set([...started].filter(([, at]) => Date.now() - at < deps.waitMs).map(([id]) => id));
        for (const job of await findJobs(rc, { busy, skip })) {
          started.set(job.card.identifier, Date.now());
          rc.log(`${job.card.identifier} starts ${job.workflow} in workspace ${job.workspace}.`);
          const child = deps.start(jobArgs(job));
          children.set(job.workspace, child);
          const ended = () => {
            if (children.get(job.workspace) === child) children.delete(job.workspace);
            wake();
          };
          child.once('exit', ended);
          // A program that could not start never exits.
          child.once('error', (err?: Error) => {
            rc.log(`Could not start the run for ${job.card.identifier} (${err?.message ?? 'unknown error'}).`);
            ended();
          });
        }
      }
      if (!children.size) return 0;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deps.waitMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = () => {};
    }
  } catch (err) {
    rc.log(`Error: ${(err as Error).message}`);
    return 1;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    clearCurrent(rc.configDir);
  }
}
