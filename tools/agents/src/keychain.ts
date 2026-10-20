import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

const SERVICE = 'voidshift-linear';

export function readLinearKey(): string | null {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'], { encoding: 'utf8' });
  const key = r.status === 0 ? r.stdout.trim() : '';
  return key || null;
}

// Interactive: `security` prompts for the key so it never touches argv or a file.
export function promptLinearKey(): boolean {
  const r = spawnSync('/usr/bin/security', ['add-generic-password', '-U', '-s', SERVICE, '-a', userInfo().username, '-w'], {
    stdio: 'inherit',
  });
  return r.status === 0;
}
