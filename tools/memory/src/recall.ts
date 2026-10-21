import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Recall before every prompt: words in the prompt are matched against the
// index lines, and the best notes are handed to the model as context. The
// index is the whole retrieval scheme, so an unindexed note is never recalled.

const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 4000;
const MAX_TOTAL_CHARS = 6000;

const STOP = new Set(
  ('the and for you your what did our are can how with this that lets like just want need make from have will its was were been being also about maybe pretty really basically should would could does dont cant kinda sorta going gonna know right now then them they there here when where which while who why yes not but all any some more most other into out over under again once only own same than too very please help thanks thing things stuff').split(' '),
);

export function words(text: string): string[] {
  const all = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(all)];
}

export interface Match {
  score: number;
  title: string;
  path: string;
}

// Index lines look like `- [Title](folder/note.md) - keywords`. Each scores
// one point per distinct prompt word it contains.
export function match(index: string, prompt: string, limit = MAX_NOTES): Match[] {
  const ws = words(prompt);
  if (!ws.length) return [];
  const found: Match[] = [];
  for (const line of index.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const link = line.match(/\[([^\]]*)\]\(([^)]*\.md)\)/);
    if (!link) continue;
    const lower = line.toLowerCase();
    const score = ws.filter((w) => lower.includes(w)).length;
    if (score > 0) found.push({ score, title: link[1]!, path: link[2]! });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}

// The context block for one prompt. Each note comes in once per session.
export function recallContext(vault: string, prompt: string, session: string): string {
  const indexPath = join(vault, 'INDEX.md');
  if (!existsSync(indexPath)) return '';
  const seenPath = join(tmpdir(), `voidshift-memory-seen-${session.replace(/[^a-zA-Z0-9-]/g, '') || 'none'}`);
  const seen = new Set(existsSync(seenPath) ? readFileSync(seenPath, 'utf8').split('\n') : []);
  let ctx = '';
  for (const m of match(readFileSync(indexPath, 'utf8'), prompt)) {
    const note = join(vault, m.path);
    if (seen.has(m.path) || !existsSync(note)) continue;
    appendFileSync(seenPath, `${m.path}\n`);
    ctx += `\n--- ${m.path} ---\n${readFileSync(note, 'utf8').slice(0, MAX_NOTE_CHARS)}\n`;
    if (ctx.length >= MAX_TOTAL_CHARS) break;
  }
  if (!ctx) return '';
  return `[memory] Recalled notes from ${vault} (keyword match on the prompt). Point-in-time knowledge: check live state before relying on it. Full index: ${indexPath}\n${ctx}`;
}

// What Claude Code and Codex expect back from a UserPromptSubmit hook.
export const hookOutput = (context: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
