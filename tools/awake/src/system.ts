import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBattery, parseBootTime, parseSleepDisabled, parseThermalSerious } from './parse.ts';
import type { SystemReading } from './decide.ts';

const PMSET = '/usr/bin/pmset';
export const SUDOERS_PATH = '/etc/sudoers.d/voidshift-awake';
export const LABEL = 'org.devvoid.voidshift.awake';

function exec(cmd: string, args: string[], interactive = false): { ok: boolean; stdout: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : 'pipe',
    timeout: interactive ? undefined : 10_000,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

export function readSystem(): SystemReading {
  return {
    sleepDisabled: parseSleepDisabled(exec(PMSET, ['-g']).stdout),
    battery: parseBattery(exec(PMSET, ['-g', 'batt']).stdout),
    thermalSerious: parseThermalSerious(exec(PMSET, ['-g', 'therm']).stdout),
    bootTime: parseBootTime(exec('/usr/sbin/sysctl', ['-n', 'kern.boottime']).stdout),
  };
}

// Never prompts: relies on the sudoers rule installed at setup.
export function setSleepDisabled(disabled: boolean): boolean {
  return exec('/usr/bin/sudo', ['-n', PMSET, '-a', 'disablesleep', disabled ? '1' : '0']).ok;
}

// Another tool's sudoers rule can make ruleWorks() true on its own, so
// installation and health both key on our own file existing.
export function ruleInstalled(): boolean {
  return existsSync(SUDOERS_PATH);
}

export function ruleWorks(): boolean {
  return exec('/usr/bin/sudo', ['-n', '-l', PMSET, '-a', 'disablesleep', '1']).ok;
}

// Allows exactly the two pmset invocations awake needs, for this user only.
export function sudoersRule(user: string): string {
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user) || user.toUpperCase() === 'ALL') throw new Error(`unexpected user name: ${user}`);
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1\n`;
}

// Interactive: sudo asks for the user's password once. The rule is checked
// with visudo before it is installed, so a bad file can never lock sudo.
export function installSudoers(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'voidshift-'));
  const file = join(dir, 'voidshift-awake');
  try {
    writeFileSync(file, sudoersRule(userInfo().username), { mode: 0o600 });
    if (!exec('/usr/bin/sudo', ['/usr/sbin/visudo', '-cf', file], true).ok) return false;
    return exec('/usr/bin/sudo', ['/usr/bin/install', '-m', '0440', '-o', 'root', '-g', 'wheel', file, SUDOERS_PATH], true).ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function removeSudoers(): boolean {
  if (!existsSync(SUDOERS_PATH)) return true;
  return exec('/usr/bin/sudo', ['/bin/rm', '-f', SUDOERS_PATH], true).ok;
}

export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function watchdogPlist(program: string[], logPath: string): string {
  const args = program.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${userInfo().uid}`;

export function watchdogLoaded(): boolean {
  return exec('/bin/launchctl', ['print', `${domain()}/${LABEL}`]).ok;
}

export function loadWatchdog(home: string, program: string[], logPath: string): boolean {
  const path = plistPath(home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(path, watchdogPlist(program, logPath));
  if (watchdogLoaded()) exec('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
  return exec('/bin/launchctl', ['bootstrap', domain(), path]).ok;
}

export function unloadWatchdog(home: string): void {
  if (watchdogLoaded()) exec('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
  rmSync(plistPath(home), { force: true });
}
