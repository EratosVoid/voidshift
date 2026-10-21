// The shell: a stack of screens, the header, the footer of key hints, a toast
// line, the confirm dialog, the key help and the command palette.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { commandLine, firstLine, lastLine, runAction, runInTerminal, spawnDetached, type ActionResult } from './actions.ts';
import { usages } from '../commands/help.ts';
import {
  ScreenCtx,
  type ActionSpec,
  type Actions,
  type ConfirmOptions,
  type Hint,
  type ScreenContext,
  type ToastKind,
} from './context.ts';
import { DataProvider, updateNotice, useData, type Poller } from './data.ts';
import { useKeyBatching } from './keys.ts';
import { breadcrumb, HOME, initialStack, navReducer, type Params } from './nav.ts';
import { Palette, parseUsages, type PaletteEntry } from './palette.ts';
import { crumbsOf, hintsOf, screens } from './screens.ts';
import { theme } from './theme.ts';
import { Confirm, KeyHints, Panel } from './widgets.ts';

const h = React.createElement;

type Overlay =
  | { type: 'confirm'; options: ConfirmOptions; command?: string[]; resolve(ok: boolean): void }
  | { type: 'palette' }
  | { type: 'help' };

interface Meta {
  hints?: Hint[] | null;
  command?: string[] | null;
  right?: { text: string; colour?: string } | null;
}

interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

const toastColour = (k: ToastKind) => (k === 'ok' ? theme.green : k === 'error' ? theme.red : theme.accent);
const toastMark = (k: ToastKind) => (k === 'ok' ? '✓' : k === 'error' ? '✗' : '·');

export function App(props: { poller?: Poller }): React.ReactElement {
  return h(DataProvider, { poller: props.poller }, h(Shell));
}

export function Shell(): React.ReactElement {
  const { exit, suspendTerminal } = useApp();
  const data = useData();
  const { columns, rows } = useWindowSize();
  const [stack, dispatch] = useReducer(navReducer, undefined, initialStack);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [meta, setMeta] = useState<Record<number, Meta>>({});
  const [, bump] = useState(0);
  const captures = useRef<Record<number, number>>({});
  const guards = useRef<Record<number, (() => boolean) | null>>({});
  const toastId = useRef(0);
  const umbrella = useMemo<PaletteEntry[]>(() => parseUsages(usages), []);
  const top = stack.length - 1;
  const route = stack[top]!;

  const showToast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++toastId.current;
    setToast({ id, text, kind });
    if (kind !== 'info') setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 5000);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions, command?: string[]) =>
      new Promise<boolean>((resolve) => {
        setOverlay({
          type: 'confirm',
          options,
          command,
          resolve: (ok) => {
            setOverlay(null);
            resolve(ok);
          },
        });
      }),
    [],
  );

  const terminal = useCallback(
    async (args: string[]): Promise<number> => {
      let code = 1;
      await suspendTerminal(async () => {
        process.stdout.write(`\n$ ${commandLine(args)}\n\n`);
        code = runInTerminal(args);
        process.stdout.write(`\n${code === 0 ? 'Done.' : `Exited with code ${code}.`} Press Enter to return to vsf. `);
        await new Promise<void>((resolve) => {
          const onData = () => {
            process.stdin.off('data', onData);
            process.stdin.pause();
            resolve();
          };
          process.stdin.on('data', onData);
          process.stdin.resume();
        });
      });
      data.refresh();
      return code;
    },
    [suspendTerminal, data.refresh],
  );

  const actions = useMemo<Actions>(
    () => ({
      confirm: (options) => confirm(options),
      terminal,
      detach(args, logFile, text) {
        try {
          spawnDetached(args, logFile);
          showToast(text ?? `Started ${commandLine(args)}`, 'ok');
          setTimeout(data.refresh, 1500);
        } catch (err) {
          showToast((err as Error).message, 'error');
        }
      },
      async run(spec: ActionSpec): Promise<ActionResult | null> {
        if (!spec.noConfirm) {
          const ok = await confirm(
            { title: spec.title, body: spec.body, confirmLabel: spec.confirmLabel, cancelLabel: spec.cancelLabel },
            spec.args,
          );
          if (!ok) return null;
        }
        showToast(`Running ${commandLine(spec.args)}`, 'info');
        const result = await runAction(spec.args, { timeoutMs: spec.timeoutMs });
        data.refresh();
        if (result.code === 0) {
          showToast(spec.done ?? (firstLine(result.output) || 'Done'), 'ok');
          spec.after?.(result);
        } else {
          showToast(lastLine(result.output) || `${commandLine(spec.args)} failed (exit code ${result.code})`, 'error');
        }
        return result;
      },
    }),
    [confirm, terminal, showToast, data.refresh],
  );

  const patchMeta = useCallback((index: number, patch: Meta) => setMeta((m) => ({ ...m, [index]: { ...m[index], ...patch } })), []);

  // One context per stacked screen, so a hidden screen cannot change the footer.
  const contexts = useMemo(
    () =>
      stack.map((r, index): ScreenContext => {
        const isTop = index === top;
        return {
          id: r.id,
          params: r.params,
          nav: {
            push: (id: string, params?: Params) => dispatch({ type: 'push', id, params }),
            pop: () => dispatch({ type: 'pop' }),
            replace: (id: string, params?: Params) => dispatch({ type: 'replace', id, params }),
            depth: stack.length,
          },
          actions,
          toast: showToast,
          setHints: (hints) => patchMeta(index, { hints }),
          setCommand: (args) => patchMeta(index, { command: args }),
          setHeaderRight: (text, colour) => patchMeta(index, { right: text ? { text, colour } : null }),
          capture: () => {
            captures.current[index] = (captures.current[index] ?? 0) + 1;
            bump((n) => n + 1);
            return () => {
              captures.current[index] = Math.max(0, (captures.current[index] ?? 1) - 1);
              bump((n) => n + 1);
            };
          },
          capturing: isTop && (captures.current[index] ?? 0) > 0,
          setBackGuard: (fn) => {
            guards.current[index] = fn;
          },
          modalOpen: overlay !== null || !isTop,
          columns,
          rows,
        };
      }),
    [stack, top, overlay, actions, showToast, patchMeta, columns, rows, captures.current[top]],
  );

  // Hints and the equivalent command belong to the entry they were set on.
  useEffect(() => {
    setMeta((m) => Object.fromEntries(Object.entries(m).filter(([i]) => Number(i) <= top)));
  }, [top]);

  const topCapturing = (captures.current[top] ?? 0) > 0;
  // Several keys in one chunk are handled one by one, except into a text field.
  useKeyBatching(() => topCapturing || overlay?.type === 'palette');
  useInput(
    (input, key) => {
      if (overlay || topCapturing) return;
      if (key.escape) {
        if (guards.current[top]?.()) return;
        dispatch({ type: 'pop' });
      } else if (input === 'q') exit();
      else if (input === ':') setOverlay({ type: 'palette' });
      else if (input === '?') setOverlay({ type: 'help' });
    },
    { isActive: true },
  );

  // ---- render ----
  const crumbs = breadcrumb(stack, (r) => crumbsOf(r.id, r.params));
  const notice = updateNotice(data.state.update);
  const right = meta[top]?.right;
  const header = h(
    Box,
    { paddingX: 1, flexShrink: 0 },
    h(
      Box,
      { flexGrow: 1 },
      route.id === HOME
        ? h(Text, null, h(Text, { bold: true, color: theme.bold }, 'VoidShift'), h(Text, { color: theme.dim }, ` ${data.state.version}`))
        : h(
            Text,
            null,
            ...crumbs.flatMap((c, i) => [
              i > 0 ? h(Text, { key: `s${i}`, color: theme.dim }, ' › ') : null,
              h(Text, { key: `c${i}`, bold: i === 0, color: i === 0 ? theme.bold : undefined }, c),
            ]),
          ),
    ),
    right
      ? h(Text, { color: right.colour ?? theme.dim }, right.text)
      : notice
        ? h(Text, { color: theme.yellow }, route.id === HOME ? `${notice} is out · u updates` : `${notice} is out`)
        : null,
  );

  const body = h(
    Box,
    { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
    ...stack.map((r, index) => {
      const screen = screens[r.id];
      const visible = index === top && overlay === null;
      return h(
        Box,
        { key: `${index}:${r.id}`, display: visible ? 'flex' : 'none', flexDirection: 'column' },
        h(
          ScreenCtx.Provider,
          { value: contexts[index]! },
          screen ? h(screen.component, { params: r.params }) : h(Text, { color: theme.red }, `Unknown screen ${r.id}`),
        ),
      );
    }),
    overlay ? renderOverlay(overlay, { umbrella, setOverlay, data, terminal, hints: footerHints(route, meta[top]) }) : null,
  );

  const toastLine = h(
    Box,
    { paddingX: 1, flexShrink: 0, height: 1 },
    toast ? h(Text, { color: toastColour(toast.kind), wrap: 'truncate-end' }, `${toastMark(toast.kind)} ${toast.text}`) : h(Text, null, ' '),
  );

  let hints = footerHints(route, meta[top]);
  let command = meta[top]?.command ?? null;
  if (overlay?.type === 'confirm') {
    hints = [
      { key: '←→', label: 'choose' },
      { key: 'enter', label: 'confirm' },
      { key: 'esc', label: 'cancel' },
    ];
    command = overlay.command ?? null;
  } else if (overlay?.type === 'palette') {
    hints = [
      { key: 'enter', label: 'run' },
      { key: 'tab', label: 'complete' },
      { key: '↑↓', label: 'pick' },
      { key: 'esc', label: 'close' },
    ];
    command = null;
  } else if (overlay?.type === 'help') {
    hints = [{ key: 'esc', label: 'close' }];
    command = null;
  }
  const footer = h(Box, { flexShrink: 0 }, h(KeyHints, { hints, width: columns, right: command ? `= ${commandLine(command)}` : undefined }));

  return h(Box, { flexDirection: 'column', height: rows, width: columns }, header, body, toastLine, footer);
}

function footerHints(route: { id: string; params: Params }, meta: Meta | undefined): Hint[] {
  return meta?.hints ?? hintsOf(route.id, route.params);
}

function renderOverlay(
  overlay: Overlay,
  env: {
    umbrella: PaletteEntry[];
    setOverlay(o: Overlay | null): void;
    data: ReturnType<typeof useData>;
    terminal(args: string[]): Promise<number>;
    hints: Hint[];
  },
): React.ReactElement {
  if (overlay.type === 'confirm') {
    return h(Confirm, {
      title: overlay.options.title,
      body: overlay.options.body,
      confirmLabel: overlay.options.confirmLabel,
      cancelLabel: overlay.options.cancelLabel,
      onConfirm: () => overlay.resolve(true),
      onCancel: () => overlay.resolve(false),
    });
  }
  if (overlay.type === 'palette') {
    return h(Palette, {
      umbrella: env.umbrella,
      onClose: () => env.setOverlay(null),
      onRun: async (args) => {
        const r = await runAction(args);
        env.data.refresh();
        return r;
      },
      onTerminal: (args) => void env.terminal(args),
    });
  }
  return h(HelpOverlay, { hints: env.hints, onClose: () => env.setOverlay(null) });
}

const GLOBAL_KEYS: Hint[] = [
  { key: 'esc', label: 'go back' },
  { key: ':', label: 'command palette: every vsf command' },
  { key: '?', label: 'this list' },
  { key: 'q', label: 'quit' },
  { key: 'ctrl+c', label: 'quit from anywhere' },
];

function HelpOverlay(props: { hints: Hint[]; onClose(): void }): React.ReactElement {
  useInput(() => props.onClose());
  const line = (hint: Hint, i: number, tag = '') =>
    h(
      Text,
      { key: `${tag}${i}` },
      h(Text, { color: theme.accent }, hint.key.padEnd(8)),
      h(Text, null, hint.label),
    );
  return h(
    Panel,
    { title: 'Keys', focused: true },
    h(Text, { color: theme.dim }, 'On this screen'),
    ...props.hints.map((hint, i) => line(hint, i, 's')),
    h(Text, null, ' '),
    h(Text, { color: theme.dim }, 'Everywhere'),
    ...GLOBAL_KEYS.map((hint, i) => line(hint, i, 'g')),
  );
}
