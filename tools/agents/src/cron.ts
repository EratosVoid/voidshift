// Five field cron schedules: minute hour day-of-month month day-of-week, each
// a list of *, numbers, ranges and steps (*/15, 1-5, 0,30). Sunday is 0 or 7.
// When both day fields are restricted, either may match, as in classic cron.
const FIELDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface Schedule {
  sets: Set<number>[];
  anyDom: boolean;
  anyDow: boolean;
}

function field(text: string, [min, max]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    const lo = m[1] === '*' ? min : Number(m[2]);
    const hi = m[1] === '*' ? max : m[3] ? Number(m[3]) : m[4] ? max : lo;
    if (step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(schedule: string): Schedule | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = field(parts[i]!, FIELDS[i]!);
    if (!s) return null;
    sets.push(s);
  }
  if (sets[4]!.has(7)) sets[4]!.add(0);
  return { sets, anyDom: parts[2] === '*', anyDow: parts[4] === '*' };
}

export function matches(s: Schedule, d: Date): boolean {
  const [min, hour, dom, month, dow] = s.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !month.has(d.getMonth() + 1)) return false;
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(d.getDay());
  if (s.anyDom || s.anyDow) return domOk && dowOk;
  return domOk || dowOk;
}

const MINUTE = 60_000;
// How far back a missed schedule is still made up for, e.g. after the runner
// was busy or the machine was off. Older misses are skipped, not queued.
export const CATCH_UP_MS = 24 * 60 * MINUTE;

// The latest minute after `since` and up to `now` that the schedule matches,
// or null. Only the latest counts: several missed runs fire once.
export function lastDue(s: Schedule, since: Date, now: Date): Date | null {
  const floor = Math.max(since.getTime(), now.getTime() - CATCH_UP_MS);
  const t = new Date(now);
  t.setSeconds(0, 0);
  for (; t.getTime() > floor; t.setTime(t.getTime() - MINUTE)) if (matches(s, t)) return new Date(t);
  return null;
}
