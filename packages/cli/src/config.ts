import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from './tool.ts';
import { defaultsUi, ui } from './ui.ts';

// ~/.config/voidshift, not ~/.voidshift: the older private daemon owns that.
export function configDir(): string {
  return process.env.VOIDSHIFT_HOME ?? join(homedir(), '.config', 'voidshift');
}

interface Config {
  tools: string[];
}

const configPath = () => join(configDir(), 'config.json');

export function readConfig(): Config {
  if (!existsSync(configPath())) return { tools: [] };
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Config;
}

export function writeConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

// `quiet` routes tool output through the setup UI instead of plain lines.
export function context(quiet = false, defaults = false): ToolContext {
  return {
    defaults,
    home: homedir(),
    configDir: configDir(),
    selfCommand: [process.execPath, realpathSync(process.argv[1] ?? '')],
    log: quiet ? (line) => ui.info(line) : (line) => console.log(line),
    ui: defaults ? defaultsUi : ui,
  };
}
