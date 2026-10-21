// Linear over GraphQL with a personal API key (sent raw, no Bearer prefix).
// Only the background runner uses this; interactive agents use the Linear
// connection inside Claude Code or Codex.

export interface Card {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  branchName: string;
  teamId: string;
  teamKey: string;
  projectName?: string;
  labels: string[];
}

const ENDPOINT = 'https://api.linear.app/graphql';

const CARD_FIELDS = `
  id identifier title description url branchName
  team { id key }
  project { name }
  labels { nodes { name } }
`;

function mapCard(n: any): Card {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? undefined,
    url: n.url,
    branchName: n.branchName,
    teamId: n.team.id,
    teamKey: n.team.key,
    projectName: n.project?.name ?? undefined,
    labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
  };
}

export function createLinear(apiKey: string) {
  async function gql(operation: string, query: string, variables: Record<string, unknown> = {}): Promise<any> {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`could not reach Linear (${cause?.code ?? cause?.message ?? (err as Error).message})`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // reported below
    }
    const error = json?.errors?.[0]?.message;
    if (!res.ok || error || !json) throw new Error(`linear ${operation} ${res.status}: ${error ?? text.slice(0, 200)}`);
    return json.data;
  }

  async function labelId(name: string, teamId: string): Promise<string> {
    const found = await gql(
      'findLabel',
      `query FindLabel($name: String!, $teamId: ID) {
        issueLabels(filter: { name: { eq: $name }, or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
          nodes { id name }
        }
      }`,
      { name, teamId },
    );
    const existing = (found?.issueLabels?.nodes ?? []).find((l: any) => l.name === name);
    if (existing) return existing.id;
    const created = await gql(
      'createLabel',
      `mutation CreateLabel($name: String!, $teamId: String) {
        issueLabelCreate(input: { name: $name, teamId: $teamId }) { issueLabel { id } }
      }`,
      { name, teamId },
    );
    const id = created?.issueLabelCreate?.issueLabel?.id;
    if (!id) throw new Error(`linear could not create label ${name}`);
    return id;
  }

  return {
    async viewer(): Promise<{ id: string; name: string }> {
      const d = await gql('viewer', 'query { viewer { id name } }');
      return d.viewer;
    },

    // Every team, with whether I am a member, members first.
    async teams(): Promise<{ key: string; name: string; mine: boolean }[]> {
      const d = await gql('teams', 'query { teams(first: 100) { nodes { key name } } viewer { teams(first: 100) { nodes { key } } } }');
      const mine = new Set((d?.viewer?.teams?.nodes ?? []).map((t: { key: string }) => t.key));
      const all: { key: string; name: string }[] = d?.teams?.nodes ?? [];
      return all.map((t) => ({ ...t, mine: mine.has(t.key) })).sort((a, b) => Number(b.mine) - Number(a.mine));
    },

    // My cards carrying the trigger label.
    async myCardsWithLabel(label: string): Promise<Card[]> {
      const d = await gql(
        'myCards',
        `query MyCards($label: String!) {
          issues(first: 20, orderBy: createdAt, filter: { assignee: { isMe: { eq: true } }, labels: { name: { eq: $label } } }) {
            nodes { ${CARD_FIELDS} }
          }
        }`,
        { label },
      );
      return (d?.issues?.nodes ?? []).map(mapCard);
    },

    async card(identifier: string): Promise<Card> {
      const d = await gql('card', `query Card($id: String!) { issue(id: $id) { ${CARD_FIELDS} } }`, { id: identifier });
      if (!d?.issue) throw new Error(`linear has no card ${identifier}`);
      return mapCard(d.issue);
    },

    async comments(identifier: string): Promise<{ body: string; createdAt: string }[]> {
      const d = await gql(
        'comments',
        `query Comments($id: String!) { issue(id: $id) { comments(first: 100) { nodes { body createdAt } } } }`,
        { id: identifier },
      );
      return d?.issue?.comments?.nodes ?? [];
    },

    async comment(card: Card, body: string): Promise<void> {
      await gql(
        'comment',
        `mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
        { issueId: card.id, body },
      );
    },

    // Replace the card's label set with `next`, creating labels as needed.
    async setLabels(card: Card, next: string[]): Promise<void> {
      const ids: string[] = [];
      for (const name of next) ids.push(await labelId(name, card.teamId));
      await gql(
        'setLabels',
        `mutation SetLabels($id: String!, $labelIds: [String!]) { issueUpdate(id: $id, input: { labelIds: $labelIds }) { success } }`,
        { id: card.id, labelIds: ids },
      );
      card.labels = next;
    },

    // Move to a named workflow state; false if the team has no such state.
    async moveTo(card: Card, stateName: string): Promise<boolean> {
      const d = await gql(
        'states',
        `query States($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }`,
        { teamId: card.teamId },
      );
      const state = (d?.workflowStates?.nodes ?? []).find((s: any) => s.name.toLowerCase() === stateName.toLowerCase());
      if (!state) return false;
      await gql(
        'move',
        `mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
        { id: card.id, stateId: state.id },
      );
      return true;
    },
  };
}

export type Linear = ReturnType<typeof createLinear>;
