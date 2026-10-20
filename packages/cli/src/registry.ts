// Tools the CLI knows about. Each ships as its own npm package and is
// installed on `voidshift add <name>`. Status flips to 'available' once the
// package is published.

export interface ToolEntry {
  name: string;
  summary: string;
  pkg: string;
  status: 'planned' | 'available';
}

export const registry: ToolEntry[] = [
  {
    name: 'awake',
    summary: 'Keep the Mac running on battery with the lid closed, with guardrails',
    pkg: '@devvoid/voidshift-awake',
    status: 'available',
  },
  {
    name: 'skills',
    summary: 'Install the shared skill pack into Claude Code and Codex',
    pkg: '@devvoid/voidshift-skills',
    status: 'planned',
  },
  {
    name: 'agents',
    summary: 'Run configured agents in the background off Linear labels',
    pkg: '@devvoid/voidshift-agents',
    status: 'planned',
  },
  {
    name: 'memory',
    summary: 'Markdown memory vault recalled into Claude Code and Codex',
    pkg: '@devvoid/voidshift-memory',
    status: 'planned',
  },
];

export function findTool(name: string): ToolEntry | undefined {
  return registry.find((t) => t.name === name);
}
