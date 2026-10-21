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
