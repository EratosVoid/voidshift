import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export const helpOption = { help: { type: 'boolean', short: 'h' } } as const;

// Parse flags the same way for every command. On bad input print one plain
// line plus the usage and return null; callers then return 2.
export function parseFlags(args: string[], options: ParseArgsOptionsConfig, usage: string) {
  try {
    const { values, positionals } = parseArgs({ args, options: { ...helpOption, ...options }, allowPositionals: true, strict: true });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (err) {
    console.error(`${(err as Error).message.split('. ')[0]?.replace(/\.$/, '')}.\n\n${usage}`);
    return null;
  }
}

export const wantsHelp = (a: string[]) => a.includes('--help') || a.includes('-h');

// Commands that need prompts refuse to run without a terminal.
export function needsTerminal(command: string, hint: string): boolean {
  if (process.stdin.isTTY) return false;
  console.error(`vsf ${command} needs a terminal to ask its questions. ${hint}`);
  return true;
}
