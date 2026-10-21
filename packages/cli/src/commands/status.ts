import { context, readConfig } from '../config.ts';
import { loadTool } from '../loader.ts';
import { findTool } from '../registry.ts';
import { CLI_PKG, cliVersion, isNewer } from '../version.ts';
import { parseFlags } from './args.ts';
import { usages } from './help.ts';
import { latestVersion } from './update.ts';

// A tool's captured --json output, or its error text when it failed.
export function toolStatusJson(code: number, out: string): unknown {
  return code === 0 ? JSON.parse(out) : { error: out.trim() || `status exited ${code}` };
}

function newer(): { current: string; latest: string } | null {
  const latest = latestVersion(CLI_PKG, 3_000);
  return latest && isNewer(latest, cliVersion()) ? { current: cliVersion(), latest } : null;
}

export async function status(args: string[]): Promise<number> {
  const parsed = parseFlags(args, { json: { type: 'boolean' } }, usages.status!);
  if (!parsed) return 2;
  if (parsed.values.help) {
    console.log(usages.status);
    return 0;
  }
  const json = parsed.values.json === true;
  const base = context();
  const tools: Record<string, unknown> = {};

  for (const name of readConfig().tools) {
    const entry = findTool(name);
    if (!entry) continue;
    try {
      const tool = await loadTool(entry, base.configDir);
      const command = tool.commands?.status;
      if (!command) continue;
      if (json) {
        let out = '';
        const code = await command(['--json'], { ...base, log: (line) => (out += line + '\n') });
        tools[name] = toolStatusJson(code, out);
      } else {
        console.log(name);
        await command([], { ...base, log: (line) => console.log(line.split('\n').map((l) => `  ${l}`).join('\n')) });
      }
    } catch (err) {
      const message = (err as Error).message;
      if (json) tools[name] = { error: message };
      else console.log(`${name}: ${message}`);
    }
  }

  const update = newer();
  if (json) console.log(JSON.stringify({ tools, update }, null, 2));
  else if (update) console.log(`Update: ${update.latest} is out (you have ${update.current}). Run vsf update.`);
  return 0;
}
