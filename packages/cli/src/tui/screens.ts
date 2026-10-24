// The screen registry and the contract every screen follows.
//
// ADDING A SCREEN (one import plus one registry line)
//   1. Write your screen in its own file, e.g. src/tui/screens/runs.ts, and
//      export a Screen: `export const runsScreen: Screen = { id: 'agents.runs', ... }`.
//   2. Import it below and add its name to `registry`, after the placeholders.
//      A later entry with the same id replaces the placeholder.
//
// A SCREEN
//   id         unique, e.g. "agents.card". Ids below are fixed so Home can open them.
//   title      breadcrumb crumb(s) for the header, a string, string[] or a
//              function of the route params: (p) => ['Workflows', `Edit ${p.name}`].
//              Screens under the top one contribute only their first crumb.
//   component  a function component taking { params }. Everything else comes
//              from hooks, never from props.
//   hints      (props) => Hint[]: the default footer key hints. Use the
//              useHints() hook instead when they depend on component state.
//              End every list with { key: 'esc', label: 'back' }.
//
// WHAT A SCREEN GETS (all from ./context.ts, call them inside the component)
//   useScreen()      the ScreenContext:
//     params         the object passed to nav.push(id, params)
//     nav            push(id, params) / pop() / replace(id, params)
//     actions        run(spec): confirm dialog, then `vsf <args>` as a child
//                    process, toast, store refresh. confirm(opts). detach(args,
//                    logFile) for long runs. terminal(args) for commands that
//                    need the real terminal. NEVER do a write or a blocking
//                    command in-process; add --yes to args only for commands
//                    that take it (clean, workflow rm, project rm).
//     toast(text, kind)   'ok' | 'error' | 'info'
//     columns, rows  terminal size
//   useData()        (./data.ts) the live store: state.agents, state.runs,
//                    state.workflows, state.projects, state.homes, state.awake,
//                    state.memory, state.checks, state.steps (the hidden
//                    `vsf agents steps` catalog), state.errors[source],
//                    readConfig(tool), refresh(). Polled every 2 seconds.
//   useKeys(fn)      key handler, silent while a dialog or the palette is open
//                    and while a text field has focus.
//   useHints(list)   dynamic footer hints.
//   useEquivalent(args)   the "= vsf ..." command shown bottom right for forms
//                    and actions, e.g. useEquivalent(['agents', 'cancel', card]).
//   useCapture(on)   TextInput and Select call this for you. While a field has
//                    focus the app ignores q : ? and Esc, so a form must handle
//                    Esc itself with useKeys(fn, { whileCapturing: true }).
//   useBackGuard(fn) Esc asks this first when no field has focus; return true
//                    if you used the key (e.g. to clear a filter).
//
// WIDGETS (./widgets.ts): Panel, KeyHints, Table, SubTabs, ProgressSteps,
// Badge, Confirm, TextInput, Select, Lines/SplitRow for coloured text.
//
// SUB-TABS. "agents" is a shell: a tab bar over the screens agents.runs,
// agents.workflows, agents.projects, agents.homes and settings. Left and right
// switch tabs. A tab is an ordinary screen; it is rendered inside the shell and
// receives the shell's params plus (for settings) { tool: 'agents' }. Push
// "agents.card" { card or job, dir?, step? } for a card or job, "agents.workflow.form" { name? }
// (no name means new) and "agents.project.form" { name? } on top of the shell.
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { ScreenCtx, useScreen, type Hint, type ScreenContext } from './context.ts';
import { homeScreen } from './home.ts';
import { agentsScreen as agentsShellScreen } from './screens/agents.ts';
import { runsScreen } from './screens/runs.ts';
import { cardScreen } from './screens/log.ts';
import { settingsScreen } from './screens/settings.ts';
import { awakeScreen } from './screens/awake.ts';
import { memoryScreen } from './screens/memory.ts';
import { checksScreen } from './screens/checks.ts';
import { workflowsScreen } from './screens/workflows.ts';
import { workflowFormScreen } from './screens/workflow-form.ts';
import { projectsScreen } from './screens/projects.ts';
import { projectFormScreen } from './screens/project-form.ts';
import { homesScreen } from './screens/homes.ts';
import type { Params } from './nav.ts';
import { SubTabs } from './widgets.ts';
import { theme } from './theme.ts';

const h = React.createElement;

export interface ScreenProps {
  params: Params;
}

export interface Screen {
  id: string;
  title: string | string[] | ((params: Params) => string | string[]);
  component: (props: ScreenProps) => React.ReactElement | null;
  hints: (props: { params: Params }) => Hint[];
}

const BACK: Hint = { key: 'esc', label: 'back' };

// ---- placeholders ---------------------------------------------------------

function placeholder(id: string, title: string, extra: Partial<Screen> = {}): Screen {
  return {
    id,
    title,
    component: (props) =>
      h(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        h(Text, { bold: true, color: theme.bold }, titleOf({ title } as Screen, props.params).join(' › ')),
        h(Text, { color: theme.dim }, 'Coming in this release.'),
      ),
    hints: () => [BACK],
    ...extra,
  };
}

// ---- the agents shell -----------------------------------------------------

export interface TabDef {
  id: string;
  label: string;
  params?: Params;
}

export const AGENT_TABS: TabDef[] = [
  { id: 'agents.runs', label: 'Runs' },
  { id: 'agents.workflows', label: 'Workflows' },
  { id: 'agents.projects', label: 'Projects' },
  { id: 'agents.homes', label: 'Homes' },
  { id: 'settings', label: 'Settings', params: { tool: 'agents' } },
];

const TAB_HINT: Hint = { key: '←→', label: 'tab' };

export const activeTab = (params: Params): TabDef => AGENT_TABS.find((t) => t.id === params.tab) ?? AGENT_TABS[0]!;

// Renders another registered screen inside the current one with its own
// params. Hints it sets get `extra` appended.
export function ScreenHost(props: { id: string; params: Params; extraHints?: Hint[] }): React.ReactElement {
  const parent = useScreen();
  const screen = screens[props.id];
  if (!screen) return h(Text, { color: theme.red }, `Unknown screen ${props.id}`);
  const ctx: ScreenContext = {
    ...parent,
    id: props.id,
    params: props.params,
    setHints: (hints) => parent.setHints(hints && props.extraHints ? [...hints, ...props.extraHints] : hints),
  };
  return h(ScreenCtx.Provider, { value: ctx }, h(screen.component, { params: props.params }));
}

function AgentsShell(props: ScreenProps): React.ReactElement {
  const ctx = useScreen();
  const tab = activeTab(props.params);
  useInput(
    (_input, key) => {
      const i = AGENT_TABS.indexOf(tab);
      const next = key.rightArrow ? AGENT_TABS[(i + 1) % AGENT_TABS.length] : key.leftArrow ? AGENT_TABS[(i + AGENT_TABS.length - 1) % AGENT_TABS.length] : undefined;
      if (next) ctx.nav.replace('agents', { ...props.params, tab: next.id });
    },
    { isActive: !ctx.modalOpen && !ctx.capturing },
  );
  return h(
    Box,
    { flexDirection: 'column' },
    h(SubTabs, { tabs: AGENT_TABS.map((t) => ({ id: t.id, label: t.label })), active: tab.id }),
    h(Text, null, ' '),
    h(ScreenHost, { key: tab.id, id: tab.id, params: { ...props.params, ...tab.params }, extraHints: [TAB_HINT] }),
  );
}

const agentsScreen: Screen = {
  id: 'agents',
  title: (p) => ['Agents', activeTab(p).label],
  component: AgentsShell,
  hints: (p) => {
    const tab = activeTab(p);
    const inner = screens[tab.id];
    return [...(inner ? inner.hints({ params: { ...p, ...tab.params } }) : [BACK]), TAB_HINT];
  },
};

// ---- the registry ---------------------------------------------------------
// Add screens here. Later entries replace earlier ones with the same id.

const registry: Screen[] = [
  homeScreen,
  agentsScreen,
  placeholder('agents.runs', 'Runs'),
  placeholder('agents.workflows', 'Workflows'),
  placeholder('agents.projects', 'Projects'),
  placeholder('agents.homes', 'Homes'),
  placeholder('settings', 'Settings'),
  placeholder('agents.card', 'Card'),
  placeholder('agents.workflow.form', 'Workflow'),
  placeholder('agents.project.form', 'Project'),
  placeholder('awake', 'Awake'),
  placeholder('memory', 'Memory'),
  placeholder('checks', 'Checks'),
  agentsShellScreen,
  runsScreen,
  cardScreen,
  settingsScreen,
  awakeScreen,
  memoryScreen,
  checksScreen,
  workflowsScreen,
  workflowFormScreen,
  projectsScreen,
  projectFormScreen,
  homesScreen,
];

export const screens: Record<string, Screen> = Object.fromEntries(registry.map((s) => [s.id, s]));

export function titleOf(screen: Screen, params: Params): string[] {
  const t = typeof screen.title === 'function' ? screen.title(params) : screen.title;
  return Array.isArray(t) ? t : [t];
}

export function hintsOf(id: string, params: Params): Hint[] {
  return screens[id]?.hints({ params }) ?? [BACK];
}

export function crumbsOf(id: string, params: Params): string[] {
  const s = screens[id];
  return s ? titleOf(s, params) : [id];
}
