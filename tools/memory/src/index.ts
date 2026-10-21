import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { addHook, hasOurHook, otherRecall, recallCommand, removeHook } from './hooks.ts';
import { hookOutput, match, recallContext } from './recall.ts';
import { countNotes, isVault, memoryDir, readMemoryConfig, scaffold, skillText, writeMemoryConfig, type Home } from './vault.ts';
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
function installInto(home: Home, ctx: ToolContext): void {
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

const usage = `voidshift memory <command>
  status            The vault and where recall is set up
  search WORDS      Notes recall would bring up for these words
  recall            The prompt hook (reads the hook's JSON on stdin)`;

const memory: Tool = {
  name: 'memory',
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
    if (!saved) return [{ name: 'memory', status: 'warn', detail: 'not set up', fix: 'voidshift' }];
    const checks: Check[] = [
      isVault(saved.vault)
        ? { name: 'memory vault', status: 'ok', detail: `${tilde(saved.vault)}, ${notes(saved.vault)}` }
        : { name: 'memory vault', status: 'fail', detail: `${tilde(saved.vault)} has no INDEX.md`, fix: 'voidshift' },
    ];
    for (const h of saved.homes) {
      const ok = hasOurHook(h) || !!otherRecall(h);
      checks.push(
        ok
          ? { name: `memory recall in ${homeLabel(h)}`, status: 'ok', detail: hasOurHook(h) ? 'before every prompt' : 'by another hook' }
          : { name: `memory recall in ${homeLabel(h)}`, status: 'warn', detail: 'hook missing', fix: 'voidshift' },
      );
    }
    return checks;
  },

  commands: {
    // The UserPromptSubmit hook. Never fails the prompt: any problem means
    // no context rather than an error.
    async recall(_args, ctx) {
      try {
        if (process.env.VOIDSHIFT_RECALL === 'off') return 0;
        const saved = readMemoryConfig(ctx.configDir);
        if (!saved) return 0;
        const input = JSON.parse(readFileSync(0, 'utf8')) as { prompt?: string; session_id?: string };
        const context = recallContext(saved.vault, input.prompt ?? '', input.session_id ?? 'none');
        if (context) process.stdout.write(hookOutput(context));
      } catch {
        // no context
      }
      return 0;
    },

    async search(args, ctx) {
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved || !isVault(saved.vault)) {
        ctx.log('Memory is not set up. Run voidshift.');
        return 1;
      }
      const found = match(readFileSync(join(saved.vault, 'INDEX.md'), 'utf8'), args.join(' '), 10);
      if (!found.length) ctx.log('No notes match.');
      for (const m of found) ctx.log(`${m.title}\n  ${tilde(join(saved.vault, m.path))}`);
      return 0;
    },

    async status(_args, ctx) {
      const saved = readMemoryConfig(ctx.configDir);
      if (!saved) {
        ctx.log('Memory is not set up. Run voidshift.');
        return 1;
      }
      ctx.log(`Vault: ${tilde(saved.vault)} (${isVault(saved.vault) ? `${notes(saved.vault)}` : 'missing INDEX.md'})`);
      for (const h of saved.homes) ctx.log(`${homeLabel(h)}: ${hasOurHook(h) ? 'recall on' : otherRecall(h) ? 'recall by another hook' : 'recall missing'}`);
      return 0;
    },

    async help(_args, ctx) {
      ctx.log(usage);
      return 0;
    },
  },
};

export default memory;
