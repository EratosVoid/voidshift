import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'org.devvoid.voidshift.agents';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const domain = () => `gui/${userInfo().uid}`;
const launchctl = (args: string[]) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' }).status === 0;

export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

// launchd starts jobs with a bare environment, so carry over what the agent
// CLIs need to find themselves and their logins.
export function runnerPlist(program: string[], env: Record<string, string>, logPath: string): string {
  const args = program.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
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
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
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

export function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'VOIDSHIFT_HOME']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export const runnerLoaded = () => launchctl(['print', `${domain()}/${LABEL}`]);

export function startRunner(home: string, program: string[], logPath: string): boolean {
  const path = plistPath(home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(path, runnerPlist(program, runnerEnv(), logPath));
  if (runnerLoaded()) launchctl(['bootout', `${domain()}/${LABEL}`]);
  return launchctl(['bootstrap', domain(), path]);
}

export function stopRunner(home: string): void {
  if (runnerLoaded()) launchctl(['bootout', `${domain()}/${LABEL}`]);
  rmSync(plistPath(home), { force: true });
}
