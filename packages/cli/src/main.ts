#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { doctor } from './commands/doctor.ts';
import { addTool, listTools } from './commands/tools.ts';

const help = `voidshift: one CLI for the Void dev tools

Usage
  voidshift doctor         Check this Mac is ready
  voidshift tools          List available tools
  voidshift add <tool>     Install and set up a tool
  voidshift --version      Print the version
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'doctor':
      return doctor();
    case 'tools':
      return listTools();
    case 'add':
      return addTool(rest[0]);
    case '-v':
    case '--version':
      console.log(version());
      return 0;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(help);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${help}`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
