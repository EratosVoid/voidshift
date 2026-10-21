#!/usr/bin/env node
import { readConfig } from './config.ts';
import { config } from './commands/config.ts';
import { doctor } from './commands/doctor.ts';
import { help, mainHelp, usages } from './commands/help.ts';
import { setup, setupCommand } from './commands/setup.ts';
import { status } from './commands/status.ts';
import { update } from './commands/update.ts';
import { cliVersion } from './version.ts';
import { wantsHelp } from './commands/args.ts';
import { addTool, listTools, removeTool, runToolCommand } from './commands/tools.ts';
import { findTool } from './registry.ts';
import { Cancelled } from './ui.ts';

// Ink and React load only here, so plain commands never pay for them.
async function openDashboard(): Promise<number> {
  return (await import('./tui/run.ts')).runDashboard();
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // Umbrella commands answer --help themselves; tools handle their own.
  if (cmd && Object.hasOwn(usages, cmd) && wantsHelp(rest)) {
    console.log(usages[cmd]);
    return 0;
  }
  switch (cmd) {
    case undefined:
    case '--defaults':
      if (cmd === '--defaults') return setup(true);
      if (process.stdin.isTTY && process.stdout.isTTY) {
        if (readConfig().tools.length === 0) return setup(false);
        return openDashboard();
      }
      console.log(mainHelp());
      return 0;
    case 'ui':
      if (!(process.stdin.isTTY && process.stdout.isTTY)) {
        console.error('vsf ui needs a terminal. Use vsf status for plain output.');
        return 2;
      }
      return openDashboard();
    case 'setup':
      return setupCommand(rest);
    case 'status':
      return status(rest);
    case 'doctor':
      return doctor(rest);
    case 'config':
      return config(rest);
    case 'tools':
      return listTools();
    case 'add':
      return addTool(rest[0]);
    case 'remove':
      return removeTool(rest[0]);
    case 'update':
      return update();
    case '-v':
    case '--version':
      console.log(cliVersion());
      return 0;
    case '-h':
    case '--help':
      console.log(mainHelp());
      return 0;
    case 'help':
      return help(rest);
  }
  const tool = findTool(cmd);
  if (tool) return runToolCommand(tool, rest);
  console.error(`unknown command: ${cmd}. Run vsf help.`);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const e = err as Error & { code?: string };
  if (err instanceof Cancelled) process.exitCode = 1;
  else if (typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) {
    console.error(`vsf: ${e.message.replace(/\.$/, '')}. Run vsf help.`);
    process.exitCode = 2;
  } else {
    console.error(`vsf: ${e.message}`);
    if (process.env.VSF_DEBUG === '1' && e.stack) console.error(e.stack);
    process.exitCode = 1;
  }
}
