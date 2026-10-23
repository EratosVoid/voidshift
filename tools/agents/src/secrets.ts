import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { agentsDir } from './config.ts';

// Keys live in the macOS Keychain, or on other platforms in a file only this
// user can read, in the agents config folder.
const KEY_SHAPE = /^lin_api_[A-Za-z0-9]+$/;
// Values the Keychain is handed on stdin; anything that could break out of
// the `security -i` command line is refused.
const SAFE_VALUE = /^[A-Za-z0-9_\-.:/+=]+$/;

export const looksLikeLinearKey = (key: string) => KEY_SHAPE.test(key);

export const secretsPath = (configDir: string) => join(agentsDir(configDir), 'secrets.json');

// Where keys are kept on this machine, for messages.
export const keyStore = (platform: NodeJS.Platform = process.platform) =>
  platform === 'darwin' ? 'your macOS Keychain' : 'a file only you can read';

// The secrets file, refused when anyone but its owner can read it.
export function readSecretsFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} can be read by other users (mode ${mode.toString(8)}). Run chmod 600 on it.`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

// Written to a temporary file with mode 0600, then renamed into place, so the
// file is never readable by others, not even for a moment.
export function writeSecretsFile(path: string, values: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const service = (name: string) => `voidshift-${name}`;

export function readSecret(configDir: string, name: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service(name), '-w'], { encoding: 'utf8' });
    return (r.status === 0 ? r.stdout.trim() : '') || null;
  }
  return readSecretsFile(secretsPath(configDir))[name] || null;
}

export function storeSecret(configDir: string, name: string, value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!SAFE_VALUE.test(value) || !/^[a-z0-9-]+$/.test(name)) return false;
  if (platform === 'darwin') {
    // On stdin through `security -i`, so the value never appears in a process list.
    const command = `add-generic-password -U -s ${service(name)} -a ${userInfo().username} -w ${value}\n`;
    return spawnSync('/usr/bin/security', ['-i'], { input: command, encoding: 'utf8' }).status === 0;
  }
  const path = secretsPath(configDir);
  writeSecretsFile(path, { ...readSecretsFile(path), [name]: value });
  return true;
}

export function removeSecret(configDir: string, name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') {
    // 44 is the Keychain's "not found": already gone counts as removed.
    const status = spawnSync('/usr/bin/security', ['delete-generic-password', '-s', service(name)], { encoding: 'utf8' }).status;
    return status === 0 || status === 44;
  }
  const path = secretsPath(configDir);
  const { [name]: _gone, ...rest } = readSecretsFile(path);
  writeSecretsFile(path, rest);
  return true;
}

export const readLinearKey = (configDir: string) => readSecret(configDir, 'linear');

export const storeLinearKey = (configDir: string, key: string) => looksLikeLinearKey(key) && storeSecret(configDir, 'linear', key);
