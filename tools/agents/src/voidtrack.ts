import type { Card } from './linear.ts';

// VoidTrack over its REST API with a bearer key. Self hosted installs set
// VOIDTRACK_API_URL; the web app lives at the same address without /api.
const apiBase = () => (process.env.VOIDTRACK_API_URL ?? 'https://web.voidtrack.app/api').replace(/\/$/, '');

// One branch per card that survives a retitle: GitHub closes a pull request
// whose branch is renamed.
export const branchFor = (identifier: string) => identifier.toLowerCase();

export function mapIssue(i: any, web: string): Card {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description ?? undefined,
    url: `${web}/issue/${i.identifier}`,
    branchName: branchFor(i.identifier),
    teamId: i.team?.id ?? '',
    teamKey: i.team?.key ?? i.identifier.split('-')[0],
    projectName: i.project?.name ?? undefined,
    labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
  };
}

export function createVoidTrack(apiKey: string, fetcher: typeof fetch = fetch) {
  const base = apiBase();
  const web = base.replace(/\/api$/, '');
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetcher(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`could not reach VoidTrack (${cause?.code ?? cause?.message ?? (err as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`voidtrack ${method} ${path.split('?')[0]} ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return text ? JSON.parse(text) : {};
  }
  const enc = encodeURIComponent;

  return {
    async viewer(): Promise<{ id: string; name: string }> {
      const d = await call('GET', '/v1/users');
      const me = (d.users ?? []).find((u: any) => u.isMe);
      if (!me) throw new Error('voidtrack did not say which user this key belongs to');
      return { id: me.id, name: me.name };
    },

    // My open cards in the team carrying the label. The API cannot filter on
    // labels, so that part happens here.
    async myCardsWithLabel(label: string, team: string): Promise<Card[]> {
      const d = await call('GET', `/v1/issues?team=${enc(team)}&assignee=me&stateType=backlog,unstarted,started&sort=created&limit=200`);
      return (d.issues ?? []).map((i: any) => mapIssue(i, web)).filter((c: Card) => c.labels.includes(label));
    },

    async card(identifier: string): Promise<Card> {
      const d = await call('GET', `/v1/issues/${enc(identifier)}`);
      if (!d.issue) throw new Error(`voidtrack has no card ${identifier}`);
      return mapIssue(d.issue, web);
    },

    async comments(identifier: string): Promise<{ body: string; createdAt: string }[]> {
      const d = await call('GET', `/v1/issues/${enc(identifier)}/comments`);
      return (d.comments ?? []).map((c: any) => ({ body: c.body, createdAt: c.createdAt }));
    },

    async comment(card: Card, body: string): Promise<void> {
      await call('POST', `/v1/issues/${enc(card.identifier)}/comments`, { body });
    },

    // Labels are free text on VoidTrack and the list replaces the whole set.
    async setLabels(card: Card, next: string[]): Promise<void> {
      await call('PATCH', `/v1/issues/${enc(card.identifier)}`, { labels: next });
      card.labels = next;
    },

    // Move to a named state; false if the team has no such state.
    async moveTo(card: Card, stateName: string): Promise<boolean> {
      try {
        await call('PATCH', `/v1/issues/${enc(card.identifier)}`, { state: stateName });
        return true;
      } catch (err) {
        if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 404) return false;
        throw err;
      }
    },
  };
}
