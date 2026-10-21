#!/usr/bin/env node
import { doctor } from './commands/doctor.ts';
import { setup } from './commands/setup.ts';
import { update } from './commands/update.ts';
import { cliVersion } from './version.ts';
import { addTool, listTools, removeTool, runToolCommand } from './commands/tools.ts';
import { findTool } from './registry.ts';

const help = `voidshift: one CLI for the Void dev tools

Usage
  voidshift                   Set up: pick your tools and configure them
  voidshift --defaults        Set up with the defaults, asking only what has none
  voidshift doctor            Check this Mac is ready
  voidshift tools             List available tools
  voidshift add <tool>        Install and set up a tool
  voidshift remove <tool>     Take a tool down and uninstall it
  voidshift update            Update VoidShift and every tool you added
  voidshift <tool> <command>  Run a tool, e.g. voidshift awake on
  voidshift --version         Print the version

Awake
  voidshift awake on [--until 7am | --for 6h] [--battery 20]
  voidshift awake off
  voidshift awake status
`;

async function main(argv: string[]): Promise<number> {
  const defaults = argv.includes('--defaults');
  const [cmd, ...rest] = argv.filter((a) => a !== '--defaults');
  switch (cmd) {
    case 'doctor':
      return doctor();
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
    case undefined:
      if (process.stdin.isTTY && process.stdout.isTTY) return setup(defaults);
      console.log(help);
      return 0;
    case 'setup':
      return setup(defaults);
    case '-h':
    case '--help':
    case 'help':
      console.log(help);
      return 0;
  }
  const tool = findTool(cmd);
  if (tool) return runToolCommand(tool, rest);
  console.error(`unknown command: ${cmd}\n\n${help}`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
