import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './config.ts';
import type { Check } from './types.ts';

// Your profile: what every agent run carries, on any machine, without touching
// a Claude or Codex folder. RULES.md is added to every step's prompt, and
// claude-settings.json is passed to Claude runs, with {{profile}} standing for
// this folder so hooks can live in it.
export const profileDir = (configDir: string) => join(agentsDir(configDir), 'profile');
export const RULES_FILE = 'RULES.md';
export const CLAUDE_SETTINGS = 'claude-settings.json';

export function readRules(configDir: string): string {
  const path = join(profileDir(configDir), RULES_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

// The Claude settings with {{profile}} filled in, as text, or null when there
// are none. Throws when the file is not a JSON object.
export function renderClaudeSettings(configDir: string): string | null {
  const dir = profileDir(configDir);
  const path = join(dir, CLAUDE_SETTINGS);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').replaceAll('{{profile}}', dir);
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${CLAUDE_SETTINGS} must be a JSON object`);
  return text;
}

// Writes the rendered settings into a run folder and returns the path, or
// undefined when the profile has none.
export function claudeSettingsFile(configDir: string, runDir: string): string | undefined {
  const text = renderClaudeSettings(configDir);
  if (text === null) return undefined;
  const out = join(runDir, CLAUDE_SETTINGS);
  writeFileSync(out, text);
  return out;
}

// The prompt section for your rules, empty when there are none.
export const rulesSection = (rules: string) => (rules ? `# Your rules\n\nFollow these in everything you write, including commits and comments.\n\n${rules}` : '');

const STARTER_RULES = `<!-- Rules every agent follows on every run, on every machine.
     Write them as you would tell a teammate. Delete this comment. -->
`;

// Creates the folder with a starter RULES.md. Existing files are kept.
export function initProfile(configDir: string): string[] {
  const dir = profileDir(configDir);
  mkdirSync(dir, { recursive: true });
  const made: string[] = [];
  const rules = join(dir, RULES_FILE);
  if (!existsSync(rules)) {
    writeFileSync(rules, STARTER_RULES);
    made.push(RULES_FILE);
  }
  return made;
}

export function profileChecks(configDir: string): Check[] {
  const dir = profileDir(configDir);
  if (!existsSync(dir)) return [];
  const parts: string[] = [];
  if (readRules(configDir).replace(/<!--[\s\S]*?-->/g, '').trim()) parts.push('rules');
  try {
    if (renderClaudeSettings(configDir) !== null) parts.push('Claude settings');
  } catch (err) {
    return [{ name: 'agent profile', status: 'fail', detail: `${CLAUDE_SETTINGS}: ${(err as Error).message}`, fix: `fix ${join(dir, CLAUDE_SETTINGS)}` }];
  }
  return [parts.length ? { name: 'agent profile', status: 'ok', detail: parts.join(', ') } : { name: 'agent profile', status: 'warn', detail: 'empty', fix: `add rules to ${join(dir, RULES_FILE)}` }];
}
