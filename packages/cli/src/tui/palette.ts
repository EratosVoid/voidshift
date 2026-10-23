// The command palette. ":" opens a filterable list of every vsf command line,
// built from the umbrella usage table and each added tool's help output, plus
// picks that fill in real card names ("agents retry ENG-1407"). Enter runs the
// command through the action runner; commands that need a terminal are marked
// and handed the real terminal instead.
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { needsTerminal } from './actions.ts';
import type { ActionResult } from './actions.ts';
import type { DataState } from './data.ts';
import { editText, Panel } from './widgets.ts';
import { theme } from './theme.ts';
import { liveRunsOf, useData } from './data.ts';

const h = React.createElement;

export interface PaletteEntry {
  // The full command line after "vsf ", e.g. "agents retry CARD".
  text: string;
  desc?: string;
  // The literal words before the first placeholder or option.
  prefix: string;
  // Can run as the prefix alone (every placeholder is optional).
  runnable: boolean;
  // Comes from live data (a real card), so it runs as written.
  dynamic?: boolean;
}

// Splits "agents retry 'ENG 1'" into words. Quotes group words.
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let any = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

const isPlaceholder = (word: string) => word.startsWith('[') || word.startsWith('<') || word.startsWith('-') || word.includes('|') || (/[A-Z]/.test(word) && word === word.toUpperCase());

// Builds an entry from a command signature such as "agents run [CARD] [--from STEP]".
export function makeEntry(text: string, desc?: string, dynamic = false): PaletteEntry {
  const words = text.trim().split(/\s+/);
  const at = words.findIndex(isPlaceholder);
  const prefixWords = at === -1 ? words : words.slice(0, at);
  const rest = at === -1 ? '' : words.slice(at).join(' ');
  // Runnable as the prefix when everything after it is optional.
  const runnable = rest.replace(/\[[^\]]*\]/g, '').trim() === '';
  return { text: text.trim(), desc, prefix: prefixWords.join(' '), runnable: dynamic || runnable, dynamic };
}

// Pulls command lines out of a tool's captured help. Three shapes exist:
// "Usage: vsf awake on [..]", "  status  Description", and
// "  status [--json]\n      Description".
export function parseHelpLines(tool: string, text: string): PaletteEntry[] {
  const lines = text.split('\n');
  const out: PaletteEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const full = new RegExp(`^\\s*(?:Usage:\\s*)?vsf ${tool} (.+)$`).exec(line);
    if (full) {
      const [sig, desc] = full[1]!.trim().split(/\s{2,}/);
      if (!sig!.startsWith('<')) out.push(makeEntry(`${tool} ${sig}`, desc));
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      const [sig, desc] = line.trim().split(/\s{2,}/);
      let d = desc;
      const next = lines[i + 1];
      if (!d && next && /^ {4,}\S/.test(next)) d = next.trim();
      if (sig && !sig.startsWith('<') && !sig.startsWith('vsf ')) out.push(makeEntry(`${tool} ${sig}`, d));
    }
  }
  return out;
}

// Command lines from the umbrella usage table (commands/help.ts).
export function parseUsages(usages: Record<string, string>): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const usage of Object.values(usages)) {
    const lines = usage.split('\n');
    const hits: { sig: string; desc?: string }[] = [];
    for (const line of lines) {
      const m = /^\s*(?:Usage:\s*)?vsf (.+)$/.exec(line);
      if (!m) continue;
      const [sig, desc] = m[1]!.trim().split(/\s{2,}/);
      hits.push({ sig: sig!, desc });
    }
    // One-line usages describe themselves on the next paragraph.
    const prose = lines.find((l, i) => i > 0 && l.trim() && !/^\s*(Usage:\s*)?vsf /.test(l) && !/^\s{2,}/.test(l));
    for (const hit of hits) out.push(makeEntry(hit.sig, hit.desc ?? (hits.length === 1 ? prose : undefined)));
  }
  return out;
}

// Picks that fill in card names from live data.
export function dynamicEntries(state: Pick<DataState, 'agents' | 'runs' | 'steps'>): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const seen = new Set<string>();
  const add = (text: string, desc: string) => {
    if (!seen.has(text)) {
      seen.add(text);
      out.push(makeEntry(text, desc, true));
    }
  };
  const nameOf = (id: string) => state.steps?.steps.find((s) => s.id === id)?.name ?? id.replace(/^vs-/, '');
  for (const p of state.agents?.parked ?? []) add(`agents retry ${p.card}`, 'queue the parked card again');
  for (const c of state.agents?.interrupted ?? []) add(`agents retry ${c}`, 'queue the interrupted card again');
  for (const live of liveRunsOf(state.agents)) if (live.card) add(`agents cancel ${live.card}`, 'stop the card being worked on');
  const cards = new Set<string>();
  for (const r of state.runs) {
    if (cards.size >= 6 && !cards.has(r.card)) continue;
    cards.add(r.card);
    const rec = r.record;
    if (!rec) continue;
    if (!seen.has(`agents show ${r.card}`)) add(`agents show ${r.card}`, 'steps, outcome and labels of the latest run');
    if (rec.outcome === 'cancelled') add(`agents retry ${r.card}`, 'queue the cancelled card again');
    const last = rec.steps[rec.steps.length - 1];
    if (last && (rec.outcome === 'parked' || rec.outcome === 'cancelled')) add(`agents run ${r.card} --from ${nameOf(last.step)}`, 'run again from that step');
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');

// Entries matching what was typed, best first. Every typed word has to appear
// in the command (or, failing that, its description).
export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = norm(query.replace(/^:/, ''));
  if (!q) return entries;
  const words = q.split(' ');
  const scored: { e: PaletteEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const text = norm(e.text);
    if (text.startsWith(q)) scored.push({ e, score: 0, i });
    else if (words.every((w) => text.includes(w))) scored.push({ e, score: 1, i });
    else if (words.every((w) => norm(`${e.text} ${e.desc ?? ''}`).includes(w))) scored.push({ e, score: 2, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.e);
}

// What Tab puts in the input for an entry.
export function completion(entry: PaletteEntry): string {
  return entry.dynamic ? entry.text : entry.prefix + ' ';
}

// What Enter does with the selected entry and the text typed so far.
export type EnterAction = { run: string[] } | { fill: string } | { none: true };

export function onEnter(entry: PaletteEntry | undefined, query: string): EnterAction {
  const typed = splitCommand(query.replace(/^:/, ''));
  if (!entry) return typed.length ? { run: typed } : { none: true };
  if (entry.dynamic) return { run: splitCommand(entry.text) };
  const prefix = splitCommand(entry.prefix);
  // Words typed after the command's own: they are the card, name or flags.
  if (norm(query).startsWith(norm(entry.prefix)) && typed.length > prefix.length) return { run: typed };
  if (entry.runnable) return { run: prefix };
  // A command that needs a card or a name: complete it, the user types the rest.
  return { fill: completion(entry) };
}

const terminalNote = (e: PaletteEntry) => (needsTerminal(splitCommand(e.dynamic ? e.text : e.prefix)) ? 'opens in the terminal' : '');

// ---- the overlay ---------------------------------------------------------

export interface PaletteProps {
  umbrella: PaletteEntry[];
  onClose(): void;
  // Runs a command whose output can be captured.
  onRun(args: string[]): Promise<ActionResult>;
  // Runs a command in the real terminal.
  onTerminal(args: string[]): void;
}

const MAX_ROWS = 8;

export function Palette(props: PaletteProps): React.ReactElement {
  const data = useData();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [toolEntries, setToolEntries] = useState<PaletteEntry[]>([]);
  const [result, setResult] = useState<{ args: string[]; code: number | null; output: string } | null>(null);

  const tools = data.state.tools.join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(data.state.tools.map(async (t) => parseHelpLines(t, await data.help(t)))).then((all) => {
      if (live) setToolEntries(all.flat());
    });
    return () => {
      live = false;
    };
  }, [tools]);

  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...dynamicEntries(data.state), ...props.umbrella, ...toolEntries].filter((e) => !seen.has(e.text) && !!seen.add(e.text));
  }, [data.state.agents, data.state.runs, data.state.steps, props.umbrella, toolEntries]);

  const matches = useMemo(() => filterPalette(all, query), [all, query]);
  const index = Math.min(sel, Math.max(0, matches.length - 1));
  const entry = matches[index];
  const typed = splitCommand(query);

  useInput((input, key) => {
    if (result) {
      if (key.escape || key.return || input === 'q') props.onClose();
      return;
    }
    if (key.escape) return props.onClose();
    if (key.upArrow) return setSel(Math.max(0, index - 1));
    if (key.downArrow) return setSel(Math.min(matches.length - 1, index + 1));
    if (key.tab) {
      if (entry) {
        const v = completion(entry);
        setQuery(v);
        setCursor(v.length);
        setSel(0);
      }
      return;
    }
    if (key.return) {
      const act = onEnter(entry, query);
      if ('fill' in act) {
        setQuery(act.fill);
        setCursor(act.fill.length);
        setSel(0);
      } else if ('run' in act) {
        const args = act.run;
        if (needsTerminal(args)) {
          props.onClose();
          props.onTerminal(args);
        } else {
          setResult({ args, code: null, output: '' });
          void props.onRun(args).then((r) => setResult({ args, code: r.code, output: r.output }));
        }
      }
      return;
    }
    const r = editText(query, cursor, input, key);
    setCursor(r.cursor);
    if (r.value !== query) {
      setQuery(r.value);
      setSel(0);
    }
  });

  if (result) {
    const lines = result.output ? result.output.split('\n') : [];
    const shown = lines.slice(-14);
    return h(
      Panel,
      { title: ': command', focused: true },
      h(Text, { color: theme.accent }, `vsf ${result.args.join(' ')}`),
      h(Text, null, ' '),
      result.code === null ? h(Text, { color: theme.dim }, 'Running...') : null,
      ...shown.map((l, i) => h(Text, { key: i, wrap: 'truncate-end' }, l || ' ')),
      lines.length > shown.length ? h(Text, { color: theme.dim }, `(${lines.length - shown.length} earlier lines hidden)`) : null,
      result.code !== null
        ? h(Text, { color: result.code === 0 ? theme.green : theme.red }, result.code === 0 ? (lines.length ? ' ' : 'Done.') : `Exited with code ${result.code}.`)
        : null,
      h(Text, { color: theme.dim }, 'esc or enter closes'),
    );
  }

  const at = Math.min(cursor, query.length);
  const start = Math.max(0, Math.min(index - MAX_ROWS + 1, matches.length - MAX_ROWS));
  const visible = matches.slice(start, start + MAX_ROWS);
  const width = Math.max(...visible.map((e) => e.text.length), 20);
  return h(
    Panel,
    { title: ': command', focused: true },
    h(
      Text,
      null,
      h(Text, { color: theme.dim }, ':'),
      h(Text, null, query.slice(0, at)),
      h(Text, { inverse: true }, query[at] ?? ' '),
      h(Text, null, query.slice(at + 1)),
    ),
    h(Text, null, ' '),
    ...visible.map((e, i) => {
      const on = start + i === index;
      return h(
        Text,
        { key: e.text, wrap: 'truncate-end', backgroundColor: on ? theme.selected : undefined, bold: on },
        `${on ? '▶ ' : '  '}${e.text.padEnd(Math.min(width, 44))}  `,
        h(Text, { color: theme.dim, bold: false }, [e.desc, terminalNote(e)].filter(Boolean).join(' · ')),
      );
    }),
    matches.length === 0 && typed.length
      ? h(
          Text,
          { backgroundColor: theme.selected, bold: true },
          `▶ ${query.trim()}`,
          h(Text, { color: theme.dim, bold: false }, needsTerminal(typed) ? '  run as typed, opens in the terminal' : '  run as typed'),
        )
      : null,
    matches.length > visible.length ? h(Text, { color: theme.dim }, `  ${matches.length - visible.length} more, keep typing`) : null,
    h(Box, { marginTop: 1 }, h(Text, { color: theme.dim }, 'Every vsf command is here, with the same flags. Picks fill in card and workflow names.')),
  );
}
