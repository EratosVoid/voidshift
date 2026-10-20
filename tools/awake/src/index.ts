import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decide } from './decide.ts';
import { DEFAULT_BATTERY_FLOOR, logPath, readState, stateDir, writeState } from './state.ts';
import {
  SUDOERS_PATH,
  installSudoers,
  loadWatchdog,
  readSystem,
  removeSudoers,
  ruleInstalled,
  ruleWorks,
  setSleepDisabled,
  unloadWatchdog,
  watchdogLoaded,
} from './system.ts';
import { parseFor, parseUntil } from './time.ts';
import type { Check, Tool, ToolContext } from './types.ts';

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function ensureWatchdog(ctx: ToolContext): boolean {
  return watchdogLoaded() || loadWatchdog(ctx.home, [...ctx.selfCommand, 'awake', 'tick'], logPath(ctx.configDir));
}

async function on(args: string[], ctx: ToolContext): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { until: { type: 'string' }, for: { type: 'string' }, battery: { type: 'string' } },
  });
  const now = new Date();
  let until: Date | null = null;
  if (values.until && values.for) {
    ctx.log('Use --until or --for, not both.');
    return 2;
  }
  if (values.until) until = parseUntil(values.until, now);
  if (values.for) until = parseFor(values.for, now);
  if ((values.until || values.for) && !until) {
    ctx.log('Could not read that time. Try --until 7am, --until 19:30 or --for 6h.');
    return 2;
  }
  const floor = values.battery ? Number(values.battery) : DEFAULT_BATTERY_FLOOR;
  if (!Number.isInteger(floor) || floor < 5 || floor > 95) {
    ctx.log('--battery takes a whole percentage between 5 and 95.');
    return 2;
  }

  if (!setSleepDisabled(true)) {
    ctx.log('Could not turn sleep off. Run voidshift add awake first.');
    return 1;
  }
  writeState(ctx.configDir, {
    managed: true,
    since: now.toISOString(),
    until: until?.toISOString(),
    batteryFloor: floor,
  });
  if (!ensureWatchdog(ctx)) ctx.log('Warning: the watchdog is not running, so guardrails will not act. Run voidshift doctor.');

  const stop = until ? `at ${clock(until)} or at ${floor}% battery` : `at ${floor}% battery`;
  ctx.log(`Awake. The lid can close. Stops ${stop}, or with voidshift awake off.`);
  ctx.log('Keep it out of a bag: a closed Mac with no airflow runs hot.');
  return 0;
}

async function off(_args: string[], ctx: ToolContext): Promise<number> {
  const ok = setSleepDisabled(false);
  writeState(ctx.configDir, { ...readState(ctx.configDir), managed: false, lastReason: 'you turned it off' });
  ctx.log(ok ? 'Sleep restored.' : 'Could not restore sleep. Run: sudo pmset -a disablesleep 0');
  return ok ? 0 : 1;
}

async function status(_args: string[], ctx: ToolContext): Promise<number> {
  const state = readState(ctx.configDir);
  const sys = readSystem();
  const power = sys.battery.onBattery ? `on battery, ${sys.battery.percent ?? '?'}%` : 'on power adapter';
  if (state.managed && sys.sleepDisabled) {
    const since = state.since ? clock(new Date(state.since)) : '?';
    const stop = state.until ? `at ${clock(new Date(state.until))} or at ${state.batteryFloor}% battery` : `at ${state.batteryFloor}% battery`;
    ctx.log(`Awake since ${since}. Stops ${stop}. Mac is ${power}.`);
  } else if (sys.sleepDisabled) {
    ctx.log(`Sleep is turned off, but not by voidshift. Mac is ${power}.`);
  } else {
    const last = state.lastReason ? ` Last session ended because ${state.lastReason}.` : '';
    ctx.log(`Off. The Mac sleeps normally.${last}`);
  }
  return 0;
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
    if (!ruleInstalled() || !ruleWorks()) {
      ctx.log('Awake needs permission to turn sleep off. Enter your Mac password once:');
      if (!installSudoers()) throw new Error('could not install the sleep permission rule');
    }
    if (!ensureWatchdog(ctx)) throw new Error('could not start the watchdog');
    writeState(ctx.configDir, readState(ctx.configDir));
    ctx.log('Awake is ready. Turn it on with: voidshift awake on');
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
          ? { name: 'awake rule', status: 'warn', detail: "works only through another tool's sudoers rule", fix: 'voidshift add awake' }
          : { name: 'awake rule', status: 'fail', detail: 'cannot turn sleep off without a password', fix: 'voidshift add awake' },
    );
    checks.push(
      watchdogLoaded()
        ? { name: 'awake watchdog', status: 'ok', detail: 'running every minute' }
        : { name: 'awake watchdog', status: 'fail', detail: 'not loaded, guardrails will not act', fix: 'voidshift add awake' },
    );
    const state = readState(ctx.configDir);
    const sys = readSystem();
    if (sys.sleepDisabled && !state.managed) {
      checks.push({ name: 'awake state', status: 'warn', detail: 'sleep is off, but not by voidshift', fix: 'Another tool may be holding it. sudo pmset -a disablesleep 0 resets it' });
    } else {
      checks.push({ name: 'awake state', status: 'ok', detail: state.managed ? 'on' : 'off' });
    }
    return checks;
  },

  commands: { on, off, status, tick },
};

export default awake;
