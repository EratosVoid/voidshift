import { findTool, registry } from '../registry.ts';

export function listTools(): number {
  const width = Math.max(...registry.map((t) => t.name.length));
  for (const t of registry) {
    const tag = t.status === 'planned' ? ' (coming soon)' : '';
    console.log(`${t.name.padEnd(width)}  ${t.summary}${tag}`);
  }
  return 0;
}

export function addTool(name: string | undefined): number {
  if (!name) {
    console.error('usage: voidshift add <tool>');
    return 2;
  }
  const tool = findTool(name);
  if (!tool) {
    console.error(`unknown tool: ${name}. Run voidshift tools to see the list.`);
    return 2;
  }
  if (tool.status === 'planned') {
    console.error(`${name} is not released yet.`);
    return 1;
  }
  console.error(`installing ${tool.pkg} is not wired up yet.`);
  return 1;
}
