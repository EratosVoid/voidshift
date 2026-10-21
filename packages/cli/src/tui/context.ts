// What every screen receives. See the contract at the top of screens.ts.
import { createContext, useContext, useEffect } from 'react';
import { useInput, type Key } from 'ink';
import type { ActionResult } from './actions.ts';
import type { Params } from './nav.ts';

export interface Hint {
  key: string;
  label: string;
}

export type ToastKind = 'ok' | 'error' | 'info';

// A confirm dialog in front of a command. `args` is the exact command that
// runs ("vsf " + args) and is shown in the footer. Put --yes in args only for
// commands that take it (clean, workflow rm, project rm).
export interface ActionSpec {
  args: string[];
  // Dialog title and text. Say exactly what will happen.
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Skip the dialog (reads, or changes that are easy to undo). Default false.
  noConfirm?: boolean;
  // Toast on success. Default: the first line the command printed.
  done?: string;
  // Called after a successful run.
  after?: (result: ActionResult) => void;
  // Give the command up to this long. Default: no limit.
  timeoutMs?: number;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface Actions {
  // Confirm (unless spec.noConfirm), run `vsf <args>` as a child process, toast
  // the result and refresh the store. Resolves null when the user declined.
  run(spec: ActionSpec): Promise<ActionResult | null>;
  // Just the confirm dialog, for screens that do their own work after it.
  confirm(options: ConfirmOptions): Promise<boolean>;
  // Start a long run detached; its output is appended to logFile.
  detach(args: string[], logFile: string, toast?: string): void;
  // Hand the terminal to a command that needs it (setup, config edit, agents
  // run), then come back. Resolves with the exit code.
  terminal(args: string[]): Promise<number>;
}

export interface Nav {
  push(id: string, params?: Params): void;
  pop(): void;
  // Swap the current screen (used by tabs).
  replace(id: string, params?: Params): void;
  depth: number;
}

export interface ScreenContext {
  id: string;
  params: Params;
  nav: Nav;
  actions: Actions;
  toast(text: string, kind?: ToastKind): void;
  // Footer: key hints and the "= vsf ..." equivalent on the right.
  setHints(hints: Hint[] | null): void;
  setCommand(args: string[] | null): void;
  // Header, right side.
  setHeaderRight(text: string | null, colour?: string): void;
  // Text fields turn global keys (q : ? esc) off while they have focus.
  capture(): () => void;
  capturing: boolean;
  // Esc asks this first; return true when the screen handled it.
  setBackGuard(fn: (() => boolean) | null): void;
  // True while a dialog or the palette is open: screens must ignore keys.
  modalOpen: boolean;
  columns: number;
  rows: number;
}

export const ScreenCtx = createContext<ScreenContext | null>(null);

export function useScreen(): ScreenContext {
  const ctx = useContext(ScreenCtx);
  if (!ctx) throw new Error('useScreen needs a screen');
  return ctx;
}

// Key handler for screens. Silent while a dialog is open and, unless
// `whileCapturing`, while a text field has focus.
export function useKeys(handler: (input: string, key: Key) => void, opts: { whileCapturing?: boolean } = {}): void {
  const ctx = useScreen();
  useInput(handler, { isActive: !ctx.modalOpen && (opts.whileCapturing === true || !ctx.capturing) });
}

// Dynamic footer hints for a screen, for when its static Screen.hints is not enough.
export function useHints(hints: Hint[] | null): void {
  const ctx = useScreen();
  const key = JSON.stringify(hints);
  useEffect(() => {
    ctx.setHints(hints);
    return () => ctx.setHints(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// The command a form or action equals, shown bottom right: "= vsf agents cancel ENG-12".
export function useEquivalent(args: string[] | null): void {
  const ctx = useScreen();
  const key = JSON.stringify(args);
  useEffect(() => {
    ctx.setCommand(args);
    return () => ctx.setCommand(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// Turns global keys off while a field is focused.
export function useCapture(active: boolean): void {
  const ctx = useScreen();
  useEffect(() => (active ? ctx.capture() : undefined), [active]);
}

export function useBackGuard(fn: (() => boolean) | null): void {
  const ctx = useScreen();
  useEffect(() => {
    ctx.setBackGuard(fn);
    return () => ctx.setBackGuard(null);
  });
}
