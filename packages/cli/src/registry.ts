// Tools the CLI knows about. Each ships as its own npm package and is
// installed on `vsf add <name>`. Status flips to 'available' once the
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
    pkg: '@voidlabs.gg/voidshift-awake',
    status: 'available',
  },
  {
    name: 'agents',
    summary: 'Agents for Claude Code and Codex that plan, build and QA Linear cards',
    pkg: '@voidlabs.gg/voidshift-agents',
    status: 'available',
  },
  {
    name: 'memory',
    summary: 'Markdown memory vault recalled into Claude Code and Codex',
    pkg: '@voidlabs.gg/voidshift-memory',
    status: 'available',
  },
];

export function findTool(name: string): ToolEntry | undefined {
  return registry.find((t) => t.name === name);
}
