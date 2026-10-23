// Fakes for rendering dashboard screens without a real store or terminal.
import React from 'react';
import { DataContext, emptyState, type Data, type DataState } from '../src/tui/data.ts';
import { ScreenCtx, type Hint, type ScreenContext } from '../src/tui/context.ts';

export interface Spy {
  pushed: { id: string; params?: unknown }[];
  toasts: string[];
  ran: unknown[];
  hints: Hint[] | null;
}

export function fakeScreen(spy: Spy, over: Partial<ScreenContext> = {}): ScreenContext {
  return {
    id: 'home',
    params: {},
    nav: {
      push: (id, params) => spy.pushed.push({ id, params }),
      pop: () => {},
      replace: () => {},
      depth: 1,
    },
    actions: {
      run: async (spec) => {
        spy.ran.push(spec);
        return null;
      },
      confirm: async () => true,
      detach: () => {},
      terminal: async () => 0,
    },
    toast: (t) => spy.toasts.push(t),
    setHints: (h) => (spy.hints = h),
    setCommand: () => {},
    setHeaderRight: () => {},
    capture: () => () => {},
    capturing: false,
    setBackGuard: () => {},
    modalOpen: false,
    columns: 100,
    rows: 30,
    ...over,
  };
}

export const newSpy = (): Spy => ({ pushed: [], toasts: [], ran: [], hints: null });

export function fakeData(patch: Partial<DataState>): Data {
  return {
    state: { ...emptyState(), loaded: true, ...patch },
    refresh: () => {},
    refreshChecks: () => {},
    readConfig: () => null,
    help: async () => '',
  };
}

export function withFakes(spy: Spy, data: Data, child: React.ReactElement, over: Partial<ScreenContext> = {}): React.ReactElement {
  return React.createElement(DataContext.Provider, { value: data }, React.createElement(ScreenCtx.Provider, { value: fakeScreen(spy, over) }, child));
}

// Waits until the rendered frame passes `check`, polling, so a slow machine
// gets time instead of a fixed sleep. Throws with the last frame on timeout.
export async function frameUntil(r: { lastFrame: () => string | undefined }, check: (frame: string) => boolean, ms = 3000): Promise<string> {
  const end = Date.now() + ms;
  let frame = r.lastFrame() ?? '';
  while (!check(frame)) {
    if (Date.now() > end) throw new Error(`frame never matched within ${ms}ms. Last frame:\n${frame}`);
    await new Promise((res) => setTimeout(res, 10));
    frame = r.lastFrame() ?? '';
  }
  return frame;
}
