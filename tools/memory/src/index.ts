import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { analyzeVault, diffHomes, hasProblems, indexTargets, missingHookPaths, validateMemoryConfig } from './analyze.ts';
import { addHook, hasOurHook, hookFile, otherRecall, ourHookCommand, recallCommand, removeHook } from './hooks.ts';
import { hookOutput, match, previewContext, recallContext } from './recall.ts';
import { countNotes, isVault, listNotes, memoryDir, readMemoryConfig, scaffold, skillText, writeMemoryConfig, type Home, type MemoryConfig } from './vault.ts';
import { describeSync, isStale, readLastSync, syncVault, writeLastSync } from './sync.ts';
import type { Check, Tool, ToolContext, Ui } from './types.ts';

const has = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const tilde = (p: string) => p.replace(homedir(), '~');
const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const kindLabel = (k: Home['kind']) => (k === 'claude' ? 'Claude Code' : 'Codex');
const notes = (dir: string) => { const n = countNotes(dir); return `${n} note${n === 1 ? '' : 's'}`; };
const homeLabel = (h: Home) => `${kindLabel(h.kind)}  ${tilde(h.dir)}`;

// Claude Code reads CLAUDE_CONFIG_DIR or ~/.claude, Codex reads CODEX_HOME or
// ~/.codex, plus folders picked before.
function candidateHomes(saved: Home[]): Home[] {
  const found: Home[] = [...saved];
  if (has('claude')) for (const d of [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]) if (d) found.push({ kind: 'claude', dir: resolve(d) });
  if (has('codex')) found.push({ kind: 'codex', dir: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')) });
  return found.filter((h, i) => existsSync(h.dir) && found.findIndex((o) => o.dir === h.dir) === i);
}

// Vaults already on this Mac, for example one VoidLens keeps.
const knownVaults = (saved?: string) =>
  [saved, join(homedir(), 'memory'), join(homedir(), '.voidlens', 'memory')].filter((d, i, all): d is string => !!d && isVault(d) && all.indexOf(d) === i);

async function chooseVault(ui: Ui, saved?: string): Promise<string> {
  const fresh = join(homedir(), 'memory');
  const existing = knownVaults(saved);
  const OTHER = '__other__';
  const choices = [
    ...existing.map((d) => ({ value: d, label: tilde(d), hint: `${notes(d)}` })),
    ...(existing.includes(fresh) ? [] : [{ value: fresh, label: `${tilde(fresh)}`, hint: 'new vault' }]),
    { value: OTHER, label: 'Another folder...' },
  ];
  const picked = await ui.select('Where should memory live?', choices, saved ?? existing[0] ?? fresh);
  if (picked !== OTHER) return picked;
  return resolve(expandHome((await ui.path('Vault folder (made if missing)', { initial: homedir() + '/' })).trim()));
}

const skillDir = (configDir: string) => join(memoryDir(configDir), 'skill');

const isOurLink = (path: string, configDir: string) => {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(readlinkSync(path)) === resolve(skillDir(configDir));
  } catch {
    return false;
  }
};

// Recall hook plus the memory skill in one home. Skips what another memory
// setup already provides there, so notes never arrive twice.
function installInto(home: Home, ctx: Pick<ToolContext, 'configDir' | 'selfCommand' | 'log'>): void {
  const other = otherRecall(home);
  if (other) {
    removeHook(home);
    ctx.log(`${homeLabel(home)}: recall already set up by another hook, kept that one`);
  } else {
    addHook(home, recallCommand(ctx.selfCommand));
    ctx.log(`${homeLabel(home)}: recall before every prompt${home.kind === 'codex' ? ' (trust it once with /hooks in Codex)' : ''}`);
  }
  const link = join(home.dir, 'skills', 'memory');
  if (isOurLink(link, ctx.configDir)) return;
  if (existsSync(link) || lstatExists(link)) {
    ctx.log(`${homeLabel(home)}: a memory skill is already there, kept it`);
    return;
  }
  mkdirSync(join(home.dir, 'skills'), { recursive: true });
  symlinkSync(skillDir(ctx.configDir), link);
}

const lstatExists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function removeFrom(home: Home, configDir: string): void {
  removeHook(home);
  const link = join(home.dir, 'skills', 'memory');
  if (isOurLink(link, configDir)) rmSync(link);
}

const usages: Record<string, string> = {
  status: 'vsf memory status [--json]\n  The vault, its notes and where recall is set up',
  search: 'vsf memory search WORDS [--json]\n  Notes recall would bring up for these words',
  check: 'vsf memory check [--json]\n  Find notes recall can never reach and broken links. Exits 1 on problems',
  try: 'vsf memory try PROMPT...\n  Show what recall would add to that prompt, without changing real sessions',
  on: 'vsf memory on [DIR]\n  Turn recall on in every saved config folder, or just DIR',
  off: 'vsf memory off [DIR]\n  Turn recall off in every saved config folder, or just DIR. Keeps the skill',
  sync: 'vsf memory sync [--quiet] [--json] [--if-stale MINUTES]\n  Commit notes, pull and push the vault through its git remote (origin). Both sides of a clash are kept',
  help: 'vsf memory help [COMMAND]\n  Usage for one command, or the full list',
  recall: 'vsf memory recall\n  The prompt hook (reads the hook\'s JSON on stdin). Not run by hand',
};
const listed = ['status', 'search', 'check', 'try', 'sync', 'on', 'off', 'help'];
const fullUsage = `vsf memory <command>\n${listed.map((c) => `  ${c.padEnd(8)}${usages[c]!.split('\n')[1]!.trim()}`).join('\n')}`;

// Parses a command's flags. Returns the result, or an exit code after
// printing the usage (0 for --help, 2 for bad input).
function parse(name: string, args: string[], ctx: ToolContext, options: ParseArgsConfig['options'] = {}) {
  try {
    const r = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: true, strict: true });
    if (r.values.help) {
      ctx.log(usages[name]!);
      return 0;
    }
    return r as { values: Record<string, string | boolean | undefined>; positionals: string[] };
  } catch (e) {
    ctx.log(`${(e as Error).message.split('\n')[0]}\n${usages[name]}`);
    return 2;
  }
}

const JSON_FLAG = { json: { type: 'boolean' } } as const;

// "Oct 20 14:03" in local time.
const stamp = (d: Date) =>
  `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const skillState = (h: Home, configDir: string) => {
  const link = join(h.dir, 'skills', 'memory');
  return isOurLink(link, configDir) ? 'linked' : lstatExists(link) ? 'other' : 'missing';
};
const recallState = (h: Home) => (hasOurHook(h) ? 'on' : otherRecall(h) ? 'other' : 'off');

const notSetUp = (ctx: ToolContext) => {
  ctx.log('Memory is not set up. Run vsf setup memory.');
  return 1;
};

// Reads every note under the vault into a map keyed by relative path.
const readNotes = (vault: string) => new Map(listNotes(vault).map((p) => [p, readFileSync(join(vault, p), 'utf8')] as const));

// Homes a turn on or off applies to: all saved ones, or the one at DIR.
function pickHomes(saved: { homes: Home[] }, dir: string | undefined, ctx: ToolContext): Home[] | null {
  if (!dir) return saved.homes;
  const want = resolve(expandHome(dir));
  const found = saved.homes.filter((h) => resolve(h.dir) === want);
  if (!found.length) {
    ctx.log(`Not a memory home: ${dir}. vsf setup memory adds one.`);
    return null;
  }
  return found;
}

async function toggle(mode: 'on' | 'off', args: string[], ctx: ToolContext): Promise<number> {
  const p = parse(mode, args, ctx);
  if (typeof p === 'number') return p;
  if (p.positionals.length > 1) {
    ctx.log(`Too many arguments.\n${usages[mode]}`);
    return 2;
  }
  const saved = readMemoryConfig(ctx.configDir);
  if (!saved) return notSetUp(ctx);
  const homes = pickHomes(saved, p.positionals[0], ctx);
  if (!homes) return 1;
  if (!homes.length) {
    ctx.log('No config folders saved. Run vsf setup memory.');
    return 1;
  }
  let code = 0;
  for (const h of homes) {
    try {
      if (mode === 'off') {
        removeHook(h);
        ctx.log(`${homeLabel(h)}: recall off`);
      } else if (otherRecall(h)) ctx.log(`${homeLabel(h)}: skipped, another hook already recalls here`);
      else {
        addHook(h, recallCommand(ctx.selfCommand));
        ctx.log(`${homeLabel(h)}: recall on`);
      }
    } catch (e) {
      ctx.log(`${homeLabel(h)}: could not change ${tilde(hookFile(h))}: ${(e as Error).message}`);
      code = 1;
    }
  }
  return code;
}

const memory: Tool = {
  name: 'memory',
  contract: 1,
  summary: 'Markdown memory vault recalled into Claude Code and Codex',

  async install(ctx) {
    const { ui } = ctx;
    const saved = readMemoryConfig(ctx.configDir);
    const candidates = candidateHomes(saved?.homes ?? []);
    if (!candidates.length) throw new Error('install Claude Code or Codex first');

    const vault = await chooseVault(ui, saved?.vault);
    const made = scaffold(vault);
    ctx.log(made.length ? `Vault ${tilde(vault)}: added ${made.join(' and ')}` : `Vault ${tilde(vault)}: ${notes(vault)}`);

    const dirs = await ui.multiselect(
      'Recall memory into which config folders?',
      candidates.map((h) => ({ value: h.dir, label: homeLabel(h) })),
      saved?.homes.length ? saved.homes.map((h) => h.dir) : candidates.map((h) => h.dir),
    );
    const homes = candidates.filter((h) => dirs.includes(h.dir));
    if (!homes.length) throw new Error('pick at least one folder');

    mkdirSync(skillDir(ctx.configDir), { recursive: true });
    writeFileSync(join(skillDir(ctx.configDir), 'SKILL.md'), skillText(vault));
    for (const h of candidates) if (!homes.some((o) => o.dir === h.dir)) removeFrom(h, ctx.configDir);
    for (const h of homes) installInto(h, ctx);
    writeMemoryConfig(ctx.configDir, { vault, homes });
    ctx.log('Agents save what they learn here too. Ask Claude Code or Codex to remember something to add a note yourself.');
  },

  async uninstall(ctx) {
    const saved = readMemoryConfig(ctx.configDir);
    for (const h of candidateHomes(saved?.homes ?? [])) removeFrom(h, ctx.configDir);
    ctx.log(`Recall and the memory skill removed.${saved ? ` The vault at ${tilde(saved.vault)} was kept.` : ''}`);
  },

  async checks(ctx): Promise<Check[]> {
    const saved = readMemoryConfig(ctx.configDir);
    if (!saved) return [{ name: 'memory', status: 'warn', detail: 'not set up', fix: 'vsf setup memory' }];
    const checks: Check[] = [
      isVault(saved.vault)
        ? { name: 'memory vault', status: 'ok', detail: `${tilde(saved.vault)}, ${notes(saved.vault)}` }
        : { name: 'memory vault', status: 'fail', detail: `${tilde(saved.vault)} has no INDEX.md`, fix: 'vsf setup memory' },
    ];
    for (const h of saved.homes) {
      const name = `memory recall in ${homeLabel(h)}`;
      const ours = hasOurHook(h);
      if (!ours && !otherRecall(h)) checks.push({ name, status: 'warn', detail: 'hook missing', fix: 'vsf setup memory' });
      else {
        const missing = ours ? missingHookPaths(ourHookCommand(h) ?? '') : [];
        checks.push(
          missing.length
            ? { name, status: 'warn', detail: `recall hook points at a missing ${missing[0]}`, fix: 'vsf setup memory' }
            : { name, status: 'ok', detail: ours ? 'before every prompt' : 'by another hook' },
        );
      }
      const skill = skillState(h, ctx.configDir);
      const sname = `memory skill in ${homeLabel(h)}`;
      checks.push(
        skill === 'linked'
          ? { name: sname, status: 'ok', detail: 'linked' }
          : skill === 'other'
            ? { name: sname, status: 'ok', detail: 'another memory skill' }
            : { name: sname, status: 'warn', detail: 'memory skill missing', fix: 'vsf setup memory' },
      );
    }
    if (existsSync(join(saved.vault, '.git'))) {
      const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: saved.vault, encoding: 'utf8' });
      const last = readLastSync(ctx.configDir);
      checks.push(
        remote.status !== 0
          ? { name: 'memory sync', status: 'ok', detail: 'this machine only (add a git remote named origin to share the vault)' }
          : !last
            ? { name: 'memory sync', status: 'warn', detail: 'never synced', fix: 'vsf memory sync' }
            : last.ok
              ? { name: 'memory sync', status: 'ok', detail: `last synced ${last.at.slice(0, 16).replace('T', ' ')} UTC` }
              : { name: 'memory sync', status: 'warn', detail: `last sync failed: ${(last.message ?? '').slice(0, 120)}`, fix: 'vsf memory sync' },
      );
    }
    return checks;
  },

  config: {
    read: (configDir) => ({ ...(readMemoryConfig(configDir) ?? {}) }),
    write(configDir, value) {
      const problems = validateMemoryConfig(value, { isVault, exists: existsSync });
      if (problems.length) return problems;
      const next = value as unknown as MemoryConfig;
      const prev = readMemoryConfig(configDir);
      try {
        // Make the change real: the skill names the vault, and each home needs
        // the hook and skill link added or taken away to match.
        if (prev?.vault !== next.vault || !existsSync(join(skillDir(configDir), 'SKILL.md'))) {
          mkdirSync(skillDir(configDir), { recursive: true });
          writeFileSync(join(skillDir(configDir), 'SKILL.md'), skillText(next.vault));
        }
        const { removed, added } = diffHomes(prev?.homes ?? [], next.homes);
        for (const h of removed) removeFrom(h, configDir);
        // Same command the CLI's context() gives a tool.
        const selfCommand = [process.execPath, realpathSync(process.argv[1] ?? '')];
        for (const h of added) installInto(h, { configDir, selfCommand, log: () => {} });
      } catch (e) {
        return [`could not apply the change: ${(e as Error).message}`];
      }
      writeMemoryConfig(configDir, next);
      return [];
    },
  },

  commands: {
    // The UserPromptSubmit hook. Never fails the prompt: any problem means
    // no context rather than an error.
    async recall(args, ctx) {
      if (args.includes('--help') || args.includes('-h')) {
        ctx.log(usages.recall!);
        return 0;
      }
      try {
        if (process.env.VOIDSHIFT_RECALL === 'off') return 0;
        const saved = readMemoryConfig(ctx.configDir);
        if (!saved) return 0;
        const input = JSON.parse(readFileSync(0, 'utf8')) as { prompt?: string; session_id?: string };
        const context = recallContext(saved.vault, input.prompt ?? '', input.session_id ?? 'none');
        if (context) process.stdout.write(hookOutput(context));
        // Notes written in earlier prompts reach the remote without a timer:
        // a stale vault syncs in the background, never delaying the prompt.
        if (existsSync(join(saved.vault, '.git')) && isStale(ctx.configDir, 10)) {
          spawn(ctx.selfCommand[0]!, [...ctx.selfCommand.slice(1), 'memory', 'sync', '--quiet'], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch {
        // no context
      }
      return 0;
    },

    async search(args, ctx) {
      const p = parse('search', args, ctx, JSON_FLAG);
      if (typeof p === 'number') return p;
      if (!p.positionals.length) {
        ctx.log(`Say what to search for.\n${usages.search}`);
        return 2;
      }
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved || !isVault(saved.vault)) return notSetUp(ctx);
      const found = match(readFileSync(join(saved.vault, 'INDEX.md'), 'utf8'), p.positionals.join(' '), 10);
      if (p.values.json) {
        ctx.log(JSON.stringify(found.map((m) => ({ title: m.title, path: join(saved.vault, m.path) })), null, 2));
        return 0;
      }
      if (!found.length) ctx.log('No notes match.');
      for (const m of found) ctx.log(`${m.title}\n  ${tilde(join(saved.vault, m.path))}`);
      return 0;
    },

    async sync(args, ctx) {
      const p = parse('sync', args, ctx, { ...JSON_FLAG, quiet: { type: 'boolean' }, 'if-stale': { type: 'string' } });
      if (typeof p === 'number') return p;
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved || !isVault(saved.vault)) return p.values.quiet ? 0 : notSetUp(ctx);
      const stale = p.values['if-stale'] as string | undefined;
      if (stale !== undefined) {
        const minutes = Number(stale);
        if (!Number.isFinite(minutes) || minutes < 0) {
          ctx.log(usages.sync!);
          return 2;
        }
        if (!isStale(ctx.configDir, minutes)) return 0;
      }
      try {
        const r = syncVault(saved.vault);
        if (!r.skipped) writeLastSync(ctx.configDir, true, r.conflicts.length ? describeSync(r) : undefined);
        if (p.values.json) ctx.log(JSON.stringify(r, null, 2));
        else if (!p.values.quiet || r.conflicts.length) ctx.log(describeSync(r));
        return 0;
      } catch (err) {
        const message = (err as Error).message;
        writeLastSync(ctx.configDir, false, message);
        ctx.log(`Sync failed: ${message}`);
        return 1;
      }
    },

    async status(args, ctx) {
      const p = parse('status', args, ctx, JSON_FLAG);
      if (typeof p === 'number') return p;
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved) return notSetUp(ctx);
      const vault = isVault(saved.vault);
      const files = vault ? listNotes(saved.vault) : [];
      const targets = new Set(vault ? indexTargets(readFileSync(join(saved.vault, 'INDEX.md'), 'utf8')) : []);
      const unindexed = files.filter((f) => !targets.has(f)).sort();
      const newest = files.reduce((t, f) => Math.max(t, statSync(join(saved.vault, f)).mtimeMs), 0);
      const homes = saved.homes.map((h) => ({ kind: h.kind, dir: h.dir, recall: recallState(h), skill: skillState(h, ctx.configDir) }));
      const value = {
        vault: saved.vault,
        isVault: vault,
        notes: files.length,
        indexed: files.length - unindexed.length,
        unindexed: { count: unindexed.length, names: unindexed.slice(0, 10) },
        lastUpdated: newest ? new Date(newest).toISOString() : null,
        homes,
      };
      if (p.values.json) {
        ctx.log(JSON.stringify(value, null, 2));
        return 0;
      }
      const miss = unindexed.length ? ` (${unindexed.length} not in INDEX.md, never recalled: vsf memory check)` : '';
      ctx.log(`Vault: ${tilde(saved.vault)}, ${vault ? `${notes(saved.vault)}${miss}` : 'missing INDEX.md'}`);
      if (newest) ctx.log(`Last updated: ${stamp(new Date(newest))}`);
      for (const h of homes) ctx.log(`${homeLabel(h)}: recall ${h.recall}, skill ${h.skill}`);
      return 0;
    },

    async check(args, ctx) {
      const p = parse('check', args, ctx, JSON_FLAG);
      if (typeof p === 'number') return p;
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved || !isVault(saved.vault)) return notSetUp(ctx);
      const found = analyzeVault(readNotes(saved.vault), readFileSync(join(saved.vault, 'INDEX.md'), 'utf8'));
      if (p.values.json) ctx.log(JSON.stringify(found, null, 2));
      else if (!hasProblems(found)) ctx.log(`Vault looks good: ${found.notes} note${found.notes === 1 ? '' : 's'}, all indexed.`);
      else {
        const group = (title: string, lines: string[]) => lines.length && ctx.log(`${title} (${lines.length})\n${lines.map((l) => `  ${l}`).join('\n')}`);
        group('Not in INDEX.md, never recalled', found.unindexed);
        group('INDEX.md links to files that do not exist', found.brokenIndex);
        group('[[links]] that match no note', found.brokenLinks.map((l) => `${l.note}: [[${l.link}]]`));
      }
      return hasProblems(found) ? 1 : 0;
    },

    // Runs the matching without the per-session state, so real sessions are untouched.
    async try(args, ctx) {
      const p = parse('try', args, ctx);
      if (typeof p === 'number') return p;
      if (!p.positionals.length) {
        ctx.log(`Say what prompt to try.\n${usages.try}`);
        return 2;
      }
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved || !isVault(saved.vault)) return notSetUp(ctx);
      ctx.log(previewContext(saved.vault, p.positionals.join(' ')).trimEnd() || 'Nothing would be recalled for that prompt.');
      return 0;
    },

    async on(args, ctx) {
      return toggle('on', args, ctx);
    },

    async off(args, ctx) {
      return toggle('off', args, ctx);
    },

    async help(args, ctx) {
      const name = args.find((a) => !a.startsWith('-'));
      if (!name) {
        ctx.log(fullUsage);
        return 0;
      }
      if (!listed.includes(name)) {
        ctx.log(`No such command: ${name}\n${fullUsage}`);
        return 2;
      }
      ctx.log(usages[name]!);
      return 0;
    },
  },
};

export default memory;
