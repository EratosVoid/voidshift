import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Home = { kind: 'claude' | 'codex'; dir: string };

export interface MemoryConfig {
  vault: string;
  // Config folders recall and the memory skill are installed into.
  homes: Home[];
}

export const memoryDir = (configDir: string) => join(configDir, 'memory');
const configPath = (configDir: string) => join(memoryDir(configDir), 'config.json');

export function readMemoryConfig(configDir: string): MemoryConfig | null {
  try {
    return JSON.parse(readFileSync(configPath(configDir), 'utf8')) as MemoryConfig;
  } catch {
    return null;
  }
}

export function writeMemoryConfig(configDir: string, config: MemoryConfig): void {
  mkdirSync(memoryDir(configDir), { recursive: true });
  writeFileSync(configPath(configDir), JSON.stringify(config, null, 2) + '\n');
}

export const isVault = (dir: string) => existsSync(join(dir, 'INDEX.md'));

// Relative paths of every note: markdown files outside dot folders, except
// the vault's own INDEX.md and CONVENTIONS.md.
export function listNotes(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    // A dangling symlink or unreadable entry is skipped, not fatal.
    let kind: 'dir' | 'file' | null = null;
    try {
      const st = statSync(join(dir, name));
      kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch {
      continue;
    }
    if (kind === 'dir') {
      try {
        out.push(...listNotes(join(dir, name), rel));
      } catch {
        // unreadable folder
      }
    } else if (kind === 'file' && name.endsWith('.md') && !['INDEX.md', 'CONVENTIONS.md'].includes(name)) out.push(rel);
  }
  return out;
}

export const countNotes = (dir: string) => listNotes(dir).length;

const INDEX = `# Memory index

One line per note: \`- [Title](folder/note.md) - keywords\`. Recall matches the
words in each prompt against these lines, so use the words you would actually
say when asking. See CONVENTIONS.md.
`;

const CONVENTIONS = `# Memory conventions

The vault is a hash table: INDEX.md is the hash function and file names are the
buckets. Keeping to this is what makes recall fast and right.

## Structure
- **Folder = area**, for example \`work/\`, \`personal/\`, \`learnings/\` (patterns
  and traps that span projects). Add areas sparingly.
- **File = one topic**: \`<area>/<kebab-case-slug>.md\`. The slug should follow
  from the question you would ask.
- Keep notes under about 60 lines. Split a note that grows a second topic.

## Note format
\`\`\`markdown
---
title: Short human title
updated: YYYY-MM-DD
---

The fact or decision, stated plainly.

**Why:** the reasoning, so it can be re-derived or overturned later.

**How to apply:** what to do differently because of it.

Related: [[other-slug]]
\`\`\`

## What belongs here
- Decisions and their why, especially reversals
- Dead ends, so they are not explored again
- Learnings that are not obvious from the code
- Constraints written down nowhere else

## What does not
- Anything git already records
- Anything a repo doc or tracker card owns (link to it instead)
- Raw logs or transcripts: distill them or leave them out

## The index
Every note has exactly one line in INDEX.md:
\`\`\`
- [Title](area/slug.md) - keyword keyword keyword
\`\`\`
Update the line when the note changes meaning and delete it when the note goes.

## Hygiene
- Update in place; never create \`slug-2.md\`
- Absolute dates only, never "last week"
- Delete wrong notes rather than amending around them
`;

// Makes a folder a vault. Existing files are never touched.
export function scaffold(vault: string): string[] {
  mkdirSync(vault, { recursive: true });
  const made: string[] = [];
  for (const [name, text] of [['INDEX.md', INDEX], ['CONVENTIONS.md', CONVENTIONS]] as const) {
    const path = join(vault, name);
    if (existsSync(path)) continue;
    writeFileSync(path, text);
    made.push(name);
  }
  return made;
}

export const skillText = (vault: string) => `---
name: memory
description: Knowledge vault at ${vault} (folders are areas, INDEX.md is the index, matching notes are recalled before each prompt). Use when the user refers to past decisions or context not in the current repo ("what did we decide", "why did we", "remember when"), asks to remember something, or when the work produced a decision, dead end or learning worth keeping.
---

# Memory

Vault: \`${vault}\`. Rules: \`${vault}/CONVENTIONS.md\`. Index: \`${vault}/INDEX.md\`.

## Reading, fastest first
1. Notes matching the prompt are often recalled already, in a \`[memory]\`
   block. Use them. They are point-in-time, so check live state before relying
   on them.
2. Work out the path: folder is the area, file is the kebab-case topic. Or scan
   INDEX.md, then read the note.
3. Search the vault only when the index has nothing.

## Writing
Write a note when the work produced a decision and its why, a dead end not to
explore again, or a learning that is not obvious from the code. Do not store
what git, repo docs or the tracker already record; link to them.

- File \`<area>/<kebab-slug>.md\`, one topic, under about 60 lines.
- Frontmatter \`title\` and \`updated\` (an absolute date). Body: the fact,
  **Why:**, **How to apply:**. Link related notes with \`[[slug]]\`.
- Always add or refresh the note's line in INDEX.md:
  \`- [Title](area/slug.md) - keywords\`, with the words someone would say when
  asking. An unindexed note is never recalled.
- Update in place rather than duplicating. Delete wrong notes and their line.
`;
