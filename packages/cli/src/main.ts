#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { doctor } from './commands/doctor.ts';
import { setup } from './commands/setup.ts';
import { addTool, listTools, removeTool, runToolCommand } from './commands/tools.ts';
import { findTool } from './registry.ts';

const help = `voidshift: one CLI for the Void dev tools

Usage
  voidshift                   Set up: pick your tools and configure them
  voidshift doctor            Check this Mac is ready
  voidshift tools             List available tools
  voidshift add <tool>        Install and set up a tool
  voidshift remove <tool>     Take a tool down and uninstall it
  voidshift <tool> <command>  Run a tool, e.g. voidshift awake on
  voidshift --version         Print the version

Awake
  voidshift awake on [--until 7am | --for 6h] [--battery 20]
  voidshift awake off
  voidshift awake status
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'doctor':
      return doctor();
    case 'tools':
      return listTools();
    case 'add':
      return addTool(rest[0]);
    case 'remove':
      return removeTool(rest[0]);
    case '-v':
    case '--version':
      console.log(version());
      return 0;
    case undefined:
      if (process.stdin.isTTY && process.stdout.isTTY) return setup();
      console.log(help);
      return 0;
    case 'setup':
      return setup();
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
