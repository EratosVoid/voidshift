// Tools the CLI knows about. Each ships as its own npm package and is
// installed on `vsf add <name>`. Status flips to 'available' once the
// package is published.

export interface ToolEntry {
  name: string;
  summary: string;
  pkg: string;
  status: 'planned' | 'available';
  // Platforms the tool runs on; every platform when unset.
  platforms?: NodeJS.Platform[];
}

export const registry: ToolEntry[] = [
  {
    name: 'awake',
    summary: 'Keep the Mac running on battery with the lid closed, with guardrails',
    pkg: '@voidlabs.gg/voidshift-awake',
    status: 'available',
    platforms: ['darwin'],
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

export const runsHere = (t: ToolEntry, platform: NodeJS.Platform = process.platform) => !t.platforms || t.platforms.includes(platform);

// Why a tool cannot be added here, or null when it can.
export function unavailable(t: ToolEntry, platform: NodeJS.Platform = process.platform): string | null {
  if (t.status === 'planned') return 'coming soon';
  return runsHere(t, platform) ? null : 'macOS only';
}

export function findTool(name: string): ToolEntry | undefined {
  return registry.find((t) => t.name === name);
}
