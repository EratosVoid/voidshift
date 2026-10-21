// Small pure formatters shared by the dashboard screens.

const pad2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "14:03" in local time.
export const clock = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// "Oct 20 13:51" in local time.
export const stamp = (d: Date): string => `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock(d)}`;

// A run folder name like "2026-10-21T03-31-12-345Z" (ISO with ':' and '.' turned
// into '-') as a Date. Anything else is handed to Date as is.
export function stampDate(folder: string): Date {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/.exec(folder);
  return new Date(m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : folder);
}

// A run folder name as local "Oct 20 21:31", or "?" when it is not a date.
export function folderStamp(folder: string): string {
  const d = stampDate(folder);
  return Number.isNaN(d.getTime()) ? '?' : stamp(d);
}

// Clock time for today, date and time for any other day.
export function clockOrStamp(d: Date, now: Date = new Date()): string {
  return d.toDateString() === now.toDateString() ? clock(d) : stamp(d);
}

// "<1m", "12m", "1h 4m".
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m';
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

// "8h 50m" from whole minutes.
export function minutesText(min: number): string {
  if (min < 60) return `${Math.max(0, Math.round(min))}m`;
  return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// Cuts to max characters, ending in an ellipsis when it had to cut.
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t;
}

// Replaces the home folder with ~.
export function tilde(path: string, home: string | undefined = process.env.HOME): string {
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

// Seconds until the next runner check, given the last one. null when unknown.
export function secondsToNextCheck(lastAt: string | undefined, nowMs: number, everySec = 60): number | null {
  if (!lastAt) return null;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t + everySec * 1000 - nowMs) / 1000));
}
