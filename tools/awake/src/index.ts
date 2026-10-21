import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig, writeConfig } from './config.ts';
import { decide } from './decide.ts';
import { logPath, readState, stateDir, writeState } from './state.ts';
import {
  SUDOERS_PATH,
  installSudoers,
  loadWatchdog,
  plistPath,
  readSystem,
  removeSudoers,
  ruleInstalled,
  ruleWorks,
  setSleepDisabled,
  unloadWatchdog,
  watchdogLoaded,
} from './system.ts';
import { programPaths } from './plist.ts';
import { formatLeft, minutesLeft, parseFor, parseUntil } from './time.ts';
import type { Check, Tool, ToolContext } from './types.ts';

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function ensureWatchdog(ctx: ToolContext): boolean {
  return watchdogLoaded() || loadWatchdog(ctx.home, [...ctx.selfCommand, 'awake', 'tick'], logPath(ctx.configDir));
}

const USAGE: Record<string, string> = {
  on: 'Usage: vsf awake on [--until TIME | --for DURATION] [--battery PERCENT]\n  Keep the Mac running with the lid closed. TIME is like 7am or 19:30, DURATION like 6h.',
  off: 'Usage: vsf awake off\n  Turn sleep back on.',
  status: 'Usage: vsf awake status [--json]\n  Show whether the Mac is being kept awake, and the guardrails.',
  logs: 'Usage: vsf awake logs [-f | --follow] [--lines N]\n  Show the last N (default 50) watchdog log lines. -f keeps printing new ones.',
  help: 'Usage: vsf awake help [COMMAND]\n  Show usage for one command, or the list.',
};

const summary = () => Object.values(USAGE).map((u) => u.split('\n')[0]).join('\n');

const bad = (ctx: ToolContext, command: string, e: unknown): number => {
  ctx.log(e instanceof Error ? e.message.split(/\. To specify|\n/)[0] : String(e));
  ctx.log(USAGE[command]);
  return 2;
};

async function help(args: string[], ctx: ToolContext): Promise<number> {
  const name = args.find((a) => !a.startsWith('-'));
  if (!name) ctx.log(summary());
  else if (USAGE[name]) ctx.log(USAGE[name]);
  else {
    ctx.log(`No command called "${name}".`);
    ctx.log(summary());
    return 2;
  }
  return 0;
}

async function on(args: string[], ctx: ToolContext): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { until: { type: 'string' }, for: { type: 'string' }, battery: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    }));
  } catch (e) {
    return bad(ctx, 'on', e);
  }
  if (values.help) {
    ctx.log(USAGE.on);
    return 0;
  }
  const now = new Date();
  let until: Date | null = null;
  if (values.until && values.for) {
    ctx.log('Use --until or --for, not both.');
    ctx.log(USAGE.on);
    return 2;
  }
  if (values.until) until = parseUntil(values.until, now);
  if (values.for) until = parseFor(values.for, now);
  if ((values.until || values.for) && !until) {
    ctx.log('Could not read that time. Try --until 7am, --until 19:30 or --for 6h.');
    ctx.log(USAGE.on);
    return 2;
  }
  const prior = readState(ctx.configDir);
  const floor = values.battery ? Number(values.battery) : prior.batteryFloor;
  if (!Number.isInteger(floor) || floor < 5 || floor > 95) {
    ctx.log('--battery takes a whole percentage between 5 and 95.');
    ctx.log(USAGE.on);
    return 2;
  }

  const already = prior.managed && readSystem().sleepDisabled;
  if (!setSleepDisabled(true)) {
    ctx.log('Could not turn sleep off. Run vsf add awake first.');
    return 1;
  }
  writeState(ctx.configDir, {
    ...prior,
    managed: true,
    since: already && prior.since ? prior.since : now.toISOString(),
    // Changing only --battery on a running session keeps its end time.
    until: until ? until.toISOString() : already ? prior.until : undefined,
    batteryFloor: floor,
  });
  if (!ensureWatchdog(ctx)) ctx.log('Warning: the watchdog is not running, so guardrails will not act. Run vsf doctor.');

  const endsAt = until ?? (already && prior.until ? new Date(prior.until) : null);
  const stop = endsAt ? `at ${clock(endsAt)} or at ${floor}% battery` : `at ${floor}% battery`;
  ctx.log(already ? `Updated. Stops ${stop}, or with vsf awake off.` : `Awake. The lid can close. Stops ${stop}, or with vsf awake off.`);
  if (!already) ctx.log('Keep it out of a bag: a closed Mac with no airflow runs hot.');
  return 0;
}

async function off(args: string[], ctx: ToolContext): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
    if (values.help) {
      ctx.log(USAGE.off);
      return 0;
    }
  } catch (e) {
    return bad(ctx, 'off', e);
  }
  const ok = setSleepDisabled(false);
  writeState(ctx.configDir, { ...readState(ctx.configDir), managed: false, lastReason: 'you turned it off' });
  ctx.log(ok ? 'Sleep restored.' : 'Could not restore sleep. Run: sudo pmset -a disablesleep 0');
  return ok ? 0 : 1;
}

async function status(args: string[], ctx: ToolContext): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    }));
  } catch (e) {
    return bad(ctx, 'status', e);
  }
  if (values.help) {
    ctx.log(USAGE.status);
    return 0;
  }
  const state = readState(ctx.configDir);
  const sys = readSystem();
  const on = state.managed && sys.sleepDisabled;
  const left = on && state.until ? minutesLeft(new Date(state.until), new Date()) : null;
  const loaded = watchdogLoaded();
  if (values.json) {
    ctx.log(
      JSON.stringify(
        {
          on,
          sleepDisabledByOther: sys.sleepDisabled && !state.managed,
          since: on ? (state.since ?? null) : null,
          until: on ? (state.until ?? null) : null,
          minutesLeft: left,
          batteryFloor: state.batteryFloor,
          floorApplies: sys.battery.onBattery,
          power: { onBattery: sys.battery.onBattery, percent: sys.battery.percent },
          watchdog: loaded,
          lastReason: state.lastReason ?? null,
          heat: state.heat !== false,
          revertOnReboot: state.revertOnReboot !== false,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const power = sys.battery.onBattery ? `on battery, ${sys.battery.percent ?? '?'}%` : 'on power adapter';
  if (on) {
    const since = state.since ? clock(new Date(state.since)) : '?';
    const stop = state.until ? `at ${clock(new Date(state.until))} or at ${state.batteryFloor}% battery` : `at ${state.batteryFloor}% battery`;
    ctx.log(`Awake since ${since}. Stops ${stop}. Mac is ${power}.`);
  } else if (sys.sleepDisabled) {
    ctx.log(`Sleep is turned off, but not by VoidShift. Mac is ${power}.`);
  } else {
    const last = state.lastReason ? ` Last session ended because ${state.lastReason}.` : '';
    ctx.log(`Off. The Mac sleeps normally.${last}`);
  }
  if (left !== null) ctx.log(`Time left: ${formatLeft(left)}.`);
  if (!sys.battery.onBattery) ctx.log(`Battery floor ${state.batteryFloor}% applies on battery only; the Mac is on power now.`);
  if (!loaded) ctx.log('Watchdog: not loaded, guardrails will not act. vsf setup awake fixes it.');
  return 0;
}

async function logs(args: string[], ctx: ToolContext): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    }));
  } catch (e) {
    return bad(ctx, 'logs', e);
  }
  if (values.help) {
    ctx.log(USAGE.logs);
    return 0;
  }
  const n = values.lines === undefined ? 50 : Number(values.lines);
  if (!Number.isInteger(n) || n < 1) {
    ctx.log('--lines takes a whole number, 1 or more.');
    ctx.log(USAGE.logs);
    return 2;
  }
  const path = logPath(ctx.configDir);
  if (!existsSync(path)) {
    ctx.log('No watchdog log yet.');
    return 0;
  }
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const l of lines.slice(-n)) ctx.log(l);
  if (!values.follow) return 0;

  // Poll for appended bytes until Ctrl+C. A shrunk file means it was rotated.
  let offset = Buffer.byteLength(text);
  return new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      try {
        const size = statSync(path).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const fd = openSync(path, 'r');
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        const chunk = buf.toString('utf8').split('\n');
        if (chunk[chunk.length - 1] === '') chunk.pop();
        for (const l of chunk) ctx.log(l);
      } catch {
        // The log may be briefly missing; try again next second.
      }
    }, 1000);
    process.once('SIGINT', () => {
      clearInterval(timer);
      resolve(0);
    });
  });
}

// Run by launchd every minute.
async function tick(_args: string[], ctx: ToolContext): Promise<number> {
  const state = readState(ctx.configDir);
  if (!state.managed) return 0;
  const d = decide(state, readSystem(), new Date());
  if (d.action === 'keep') return 0;
  if (d.action === 'revert' && !setSleepDisabled(false)) {
    ctx.log(`${new Date().toISOString()} could not restore sleep (${d.reason})`);
    return 1;
  }
  writeState(ctx.configDir, { ...state, managed: false, lastReason: d.reason });
  ctx.log(`${new Date().toISOString()} sleep restored: ${d.reason}`);
  return 0;
}

const awake: Tool = {
  name: 'awake',
  summary: 'Keep the Mac running on battery with the lid closed, with guardrails',

  async install(ctx) {
    if (process.platform !== 'darwin') throw new Error('awake runs on macOS only');
    const state = readState(ctx.configDir);
    const floor = await ctx.ui.text('Turn sleep back on at what battery level (%)?', {
      initial: String(state.batteryFloor),
      validate: (v) => (/^\d+$/.test(v) && Number(v) >= 5 && Number(v) <= 95 ? undefined : 'A whole number from 5 to 95'),
    });
    writeState(ctx.configDir, { ...readState(ctx.configDir), batteryFloor: Number(floor) });
    if (!ruleInstalled() || !ruleWorks()) {
      ctx.log('Awake needs your Mac password once, to allow turning sleep off. macOS asks for it next:');
      if (!installSudoers()) throw new Error('could not install the sleep permission rule');
    }
    if (!ensureWatchdog(ctx)) throw new Error('could not start the watchdog');
    ctx.log(`Ready. vsf awake on keeps the Mac running until ${floor}% battery or vsf awake off.`);
  },

  async uninstall(ctx) {
    const state = readState(ctx.configDir);
    if (state.managed) setSleepDisabled(false);
    unloadWatchdog(ctx.home);
    ctx.log('Removing the sleep permission rule needs your password:');
    removeSudoers();
    rmSync(stateDir(ctx.configDir), { recursive: true, force: true });
  },

  async checks(ctx): Promise<Check[]> {
    const checks: Check[] = [];
    const works = ruleWorks();
    checks.push(
      ruleInstalled() && works
        ? { name: 'awake rule', status: 'ok', detail: SUDOERS_PATH }
        : works
          ? { name: 'awake rule', status: 'warn', detail: "works only through another tool's sudoers rule", fix: 'vsf setup awake' }
          : { name: 'awake rule', status: 'fail', detail: 'cannot turn sleep off without a password', fix: 'vsf setup awake' },
    );
    checks.push(
      watchdogLoaded()
        ? { name: 'awake watchdog', status: 'ok', detail: 'running every minute' }
        : { name: 'awake watchdog', status: 'fail', detail: 'not loaded, guardrails will not act', fix: 'vsf setup awake' },
    );
    const plist = plistPath(ctx.home);
    if (existsSync(plist)) {
      const missing = programPaths(readFileSync(plist, 'utf8')).find((p) => !existsSync(p));
      checks.push(
        missing
          ? { name: 'awake program', status: 'fail', detail: `watchdog points at a missing ${missing}`, fix: 'vsf setup awake' }
          : { name: 'awake program', status: 'ok', detail: 'watchdog program exists' },
      );
    }
    const state = readState(ctx.configDir);
    const sys = readSystem();
    if (sys.sleepDisabled && !state.managed) {
      checks.push({ name: 'awake state', status: 'warn', detail: 'sleep is off, but not by VoidShift', fix: 'Another tool may be holding it. sudo pmset -a disablesleep 0 resets it' });
    } else {
      checks.push({ name: 'awake state', status: 'ok', detail: state.managed ? 'on' : 'off' });
    }
    return checks;
  },

  config: { read: readConfig, write: writeConfig },

  commands: { on, off, status, logs, help, tick },
};

export default awake;
