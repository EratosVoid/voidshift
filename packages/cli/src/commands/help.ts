import { findTool, registry } from '../registry.ts';
import { toolHelp } from './tools.ts';

// Usage lines per umbrella command, shared by `vsf help <command>` and each
// command's own --help.
export const usages: Record<string, string> = {
  setup: 'Usage: vsf setup [tool] [--defaults]\n\nPick your tools and configure them, or set up one tool.\n--defaults takes every default and asks only what has none.',
  status: 'Usage: vsf status [--json]\n\nShow what each added tool is doing.',
  doctor: 'Usage: vsf doctor [--json]\n\nCheck this Mac is ready. Exits 1 when a check fails.',
  config:
    'Usage:\n  vsf config [tool] [--json]     Show saved settings\n  vsf config get KEY             Print one setting, e.g. awake.battery\n  vsf config set KEY VALUE       Change a setting (VALUE is JSON, or plain text)\n                                 Negative numbers: vsf config set KEY -- -5\n  vsf config unset KEY           Remove a setting\n  vsf config edit [tool]         Edit a tool\'s settings in $EDITOR',
  tools: 'Usage: vsf tools\n\nList available tools.',
  add: 'Usage: vsf add <tool>\n\nInstall and set up a tool.',
  remove: 'Usage: vsf remove <tool>\n\nTake a tool down and uninstall it.',
  update: 'Usage: vsf update\n\nUpdate VoidShift and every tool you added.',
  help: 'Usage: vsf help [command or tool]\n\nShow every command, or the usage of one command or tool.',
};

export function mainHelp(): string {
  const width = Math.max(...registry.map((t) => t.name.length));
  const tools = registry.map((t) => `  ${t.name.padEnd(width)}  ${t.summary}`).join('\n');
  return `vsf: one CLI for the Void dev tools

Usage
  vsf                          Dashboard (status for now)
  vsf setup [tool] [--defaults]  Pick your tools and configure them
  vsf status [--json]          What each tool is doing
  vsf doctor [--json]          Check this Mac is ready
  vsf config [tool] [--json]   Show saved settings
  vsf config get|set|unset KEY [VALUE]
  vsf config edit [tool]       Edit a tool's settings in $EDITOR
  vsf tools                    List available tools
  vsf add|remove <tool>        Install or take down a tool
  vsf update                   Update VoidShift and every tool you added
  vsf help [command or tool]   Show help
  vsf --version                Print the version

Tools
${tools}

vsf <tool> help lists a tool's commands.
`;
}

export async function help(args: string[]): Promise<number> {
  const [name] = args;
  if (!name) {
    console.log(mainHelp());
    return 0;
  }
  if (Object.hasOwn(usages, name)) {
    const usage = usages[name];
    console.log(usage);
    return 0;
  }
  const entry = findTool(name);
  if (!entry) {
    console.error(`unknown command or tool: ${name}. Run vsf help.`);
    return 2;
  }
  return toolHelp(entry, args.slice(1));
}
