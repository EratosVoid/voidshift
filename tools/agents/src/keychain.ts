import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

const SERVICE = 'voidshift-linear';
const KEY_SHAPE = /^lin_api_[A-Za-z0-9]+$/;

export function readLinearKey(): string | null {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'], { encoding: 'utf8' });
  const key = r.status === 0 ? r.stdout.trim() : '';
  return key || null;
}

export const looksLikeLinearKey = (key: string) => KEY_SHAPE.test(key);

// Stores the key through `security -i` on stdin, so it never appears in a
// process list. The shape check above rules out anything that could break
// out of the command line.
export function storeLinearKey(key: string): boolean {
  if (!looksLikeLinearKey(key)) return false;
  const command = `add-generic-password -U -s ${SERVICE} -a ${userInfo().username} -w ${key}\n`;
  return spawnSync('/usr/bin/security', ['-i'], { input: command, encoding: 'utf8' }).status === 0;
}
