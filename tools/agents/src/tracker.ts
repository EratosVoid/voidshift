import type { Tracker as Kind } from './config.ts';
import type { Card } from './linear.ts';
import { createLinear } from './linear.ts';
import { readSecret } from './secrets.ts';
import { createVoidTrack } from './voidtrack.ts';

// What the runner needs from a tracker. Linear and VoidTrack both provide it.
export interface Tracker {
  viewer(): Promise<{ id: string; name: string }>;
  myCardsWithLabel(label: string, team: string): Promise<Card[]>;
  card(identifier: string): Promise<Card>;
  comments(identifier: string): Promise<{ body: string; createdAt: string }[]>;
  comment(card: Card, body: string): Promise<void>;
  setLabels(card: Card, next: string[]): Promise<void>;
  moveTo(card: Card, stateName: string): Promise<boolean>;
}

export const TRACKERS: Record<Kind, { name: string; keyHint: string }> = {
  linear: { name: 'Linear', keyHint: 'Linear > Settings > Security & access > API keys' },
  voidtrack: { name: 'VoidTrack', keyHint: 'VoidTrack > Settings > API keys' },
};

// Opens trackers on first use, so a workflow that only uses one never needs
// the other's key.
export type Trackers = (kind: Kind) => Tracker;

export function trackersFor(configDir: string): Trackers {
  const open = new Map<Kind, Tracker>();
  return (kind) => {
    let t = open.get(kind);
    if (!t) {
      const key = readSecret(configDir, kind);
      if (!key) throw new Error(`No ${TRACKERS[kind].name} API key. Run vsf agents key${kind === 'linear' ? '' : ` --${kind}`}`);
      t = kind === 'voidtrack' ? createVoidTrack(key) : createLinear(key);
      open.set(kind, t);
    }
    return t;
  };
}

// Stands in for a tracker on a scheduled run, which has no card: reads find
// nothing and writes go nowhere.
export const noTracker: Tracker = {
  viewer: async () => ({ id: '', name: '' }),
  myCardsWithLabel: async () => [],
  card: async (id) => {
    throw new Error(`a scheduled run has no card ${id}`);
  },
  comments: async () => [],
  comment: async () => {},
  setLabels: async (card, next) => {
    card.labels = next;
  },
  moveTo: async () => false,
};
