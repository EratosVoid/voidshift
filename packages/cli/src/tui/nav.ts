// The screen stack. Pure, so it is easy to test: the app feeds actions in.

export type Params = Record<string, unknown>;

export interface Route {
  id: string;
  params: Params;
}

export type NavAction =
  | { type: 'push'; id: string; params?: Params }
  | { type: 'replace'; id: string; params?: Params }
  | { type: 'pop' }
  | { type: 'reset'; id: string; params?: Params };

export const HOME = 'home';

export const initialStack = (): Route[] => [{ id: HOME, params: {} }];

const same = (a: Route, b: Route) => a.id === b.id && JSON.stringify(a.params) === JSON.stringify(b.params);

export function navReducer(stack: Route[], action: NavAction): Route[] {
  switch (action.type) {
    case 'push': {
      const next: Route = { id: action.id, params: action.params ?? {} };
      // Pushing the screen you are already on does nothing.
      return same(stack[stack.length - 1]!, next) ? stack : [...stack, next];
    }
    case 'replace':
      return [...stack.slice(0, -1), { id: action.id, params: action.params ?? {} }];
    case 'pop':
      // The first screen never leaves the stack.
      return stack.length > 1 ? stack.slice(0, -1) : stack;
    case 'reset':
      return [{ id: action.id, params: action.params ?? {} }];
  }
}

// Breadcrumb for the header. `titles` are each route's crumbs. Screens below
// the top one give only their first crumb, so [home, agents, agents.card]
// reads "Agents > ENG-1412". Home is not part of the trail.
export function breadcrumb(stack: Route[], titles: (route: Route) => string[]): string[] {
  const rest = stack.filter((r) => r.id !== HOME);
  const out: string[] = [];
  rest.forEach((r, i) => {
    const t = titles(r);
    out.push(...(i === rest.length - 1 ? t : t.slice(0, 1)));
  });
  return out;
}
