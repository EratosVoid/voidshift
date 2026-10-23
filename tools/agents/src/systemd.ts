import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Check } from './types.ts';

// The runner on Linux: a systemd user service that runs one check, and a
// timer that starts it a minute after the last one finished.
export const UNIT = 'voidshift-agents';

const unitDir = (home: string) => join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd', 'user');
export const servicePath = (home: string) => join(unitDir(home), `${UNIT}.service`);
export const timerPath = (home: string) => join(unitDir(home), `${UNIT}.timer`);

// `systemctl --user` needs the user's runtime dir, which a `sudo -iu` or `su`
// shell does not set.
function systemctl(args: string[]): { ok: boolean; stdout: string } {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}` };
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

// One word of a unit file line: quoted, with the characters systemd expands
// escaped.
export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export function unquote(s: string): string {
  return s.replace(/\$\$/g, '$').replace(/%%/g, '%').replace(/\\(.)/g, '$1');
}

export function serviceUnit(program: string[], env: Record<string, string>, logPath: string): string {
  const vars = Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  return `[Unit]
Description=VoidShift agents runner, one check for cards to work on

[Service]
Type=oneshot
ExecStart=${program.map(quote).join(' ')}
${vars.join('\n')}
StandardOutput=append:${logPath}
StandardError=append:${logPath}
TimeoutStartSec=infinity
`;
}

export const timerUnit = () => `[Unit]
Description=Starts the VoidShift agents runner every minute

[Timer]
OnActiveSec=5s
OnUnitInactiveSec=60s
AccuracySec=1s

[Install]
WantedBy=timers.target
`;

// The words of a service unit's ExecStart line.
export function parseExecStart(unit: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? '';
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? unquote(m[1]) : m[2]!));
}

export const runnerLoaded = () => systemctl(['is-active', '--quiet', `${UNIT}.timer`]).ok;

export function startRunner(home: string, program: string[], env: Record<string, string>, logPath: string): boolean {
  mkdirSync(unitDir(home), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(servicePath(home), serviceUnit(program, env, logPath));
  writeFileSync(timerPath(home), timerUnit());
  if (!systemctl(['daemon-reload']).ok) return false;
  systemctl(['restart', `${UNIT}.timer`]);
  return systemctl(['enable', '--now', `${UNIT}.timer`]).ok;
}

export function stopRunner(home: string): void {
  systemctl(['disable', '--now', `${UNIT}.timer`]);
  systemctl(['stop', `${UNIT}.service`]);
  rmSync(servicePath(home), { force: true });
  rmSync(timerPath(home), { force: true });
  systemctl(['daemon-reload']);
}

export function programArgs(home: string): string[] | null {
  return existsSync(servicePath(home)) ? parseExecStart(readFileSync(servicePath(home), 'utf8')) : null;
}

// Without lingering, systemd stops the user's timers when they log out and
// does not start them after a reboot.
export function lingerCheck(): Check {
  const user = userInfo().username;
  const r = spawnSync('loginctl', ['show-user', user, '--property=Linger', '--value'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'yes'
    ? { name: 'runner after logout', status: 'ok', detail: 'lingering is on, the runner keeps going after logout and reboot' }
    : { name: 'runner after logout', status: 'warn', detail: 'lingering is off, the runner stops when you log out', fix: `sudo loginctl enable-linger ${user}` };
}

// Agents run with permissions skipped on Linux, so the runner's user account
// is the boundary: anything that user can do, an agent can too.
export function sudoCheck(run: typeof spawnSync = spawnSync, uid = userInfo().uid): Check {
  const name = 'runner user';
  const fix = 'Run the runner as a dedicated user with no sudo, holding only the keys it needs.';
  if (uid === 0) return { name, status: 'fail', detail: 'runs as root; Claude refuses to skip permissions as root', fix };
  const groups = (run('id', ['-Gn'], { encoding: 'utf8' }).stdout ?? '').toString().split(/\s+/);
  const admin = groups.some((g) => ['sudo', 'wheel', 'admin'].includes(g));
  if (admin || run('sudo', ['-n', 'true'], { encoding: 'utf8' }).status === 0) {
    return { name, status: 'warn', detail: 'the runner user has sudo; anything an agent runs could too', fix };
  }
  return { name, status: 'ok', detail: 'no sudo, the account limits what agents can do' };
}
