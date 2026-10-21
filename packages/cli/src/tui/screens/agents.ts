// The agents shell: a tab bar (Runs, Workflows, Projects, Homes, Settings) over
// the screens with those ids. Left and right or 1 to 5 switch tabs. The Runs
// tab is built in runs.ts; the others are rendered by id from the registry.
import React from 'react';
import { Box, useInput } from 'ink';
import { useScreen } from '../context.ts';
import { AGENT_TABS, ScreenHost, activeTab, screens, type Screen } from '../screens.ts';
import { SubTabs } from '../widgets.ts';
import type { Hint } from '../context.ts';
import { tabLock } from './runs.ts';

const h = React.createElement;

const TAB_HINT: Hint = { key: '←→', label: 'tab' };
const BACK: Hint = { key: 'esc', label: 'back' };

// The tab a key leads to, or null. `index` is the current tab.
export function nextTab(index: number, count: number, input: string, key: { leftArrow?: boolean; rightArrow?: boolean }): number | null {
  if (key.rightArrow) return (index + 1) % count;
  if (key.leftArrow) return (index + count - 1) % count;
  const n = Number(input);
  return /^[1-9]$/.test(input) && n <= count ? n - 1 : null;
}

function AgentsShell(props: { params: Record<string, unknown> }): React.ReactElement {
  const ctx = useScreen();
  const tab = activeTab(props.params);
  useInput(
    (input, key) => {
      if (tabLock.on) return;
      const to = nextTab(AGENT_TABS.indexOf(tab), AGENT_TABS.length, input, key);
      const next = to === null ? undefined : AGENT_TABS[to];
      if (next && next.id !== tab.id) ctx.nav.replace('agents', { ...props.params, tab: next.id });
    },
    { isActive: !ctx.modalOpen && !ctx.capturing },
  );
  return h(
    Box,
    { flexDirection: 'column' },
    h(SubTabs, { tabs: AGENT_TABS.map((t) => ({ id: t.id, label: t.label })), active: tab.id }),
    h(Box, { height: 1 }),
    h(ScreenHost, { key: tab.id, id: tab.id, params: { ...props.params, ...tab.params }, extraHints: [TAB_HINT] }),
  );
}

export const agentsScreen: Screen = {
  id: 'agents',
  title: (p) => ['Agents', activeTab(p).label],
  component: AgentsShell,
  hints: (p) => {
    const tab = activeTab(p);
    const inner = screens[tab.id];
    return [...(inner ? inner.hints({ params: { ...p, ...tab.params } }) : [BACK]), TAB_HINT];
  },
};
