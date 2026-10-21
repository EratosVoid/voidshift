// Pure helpers for showing a long list in a short box.

// The slice of `count` items that fits in `size` rows and keeps `index` visible.
export function windowOf(count: number, index: number, size: number): { start: number; end: number } {
  const n = Math.max(1, size);
  if (count <= n) return { start: 0, end: count };
  const start = Math.max(0, Math.min(count - n, index - Math.floor(n / 2)));
  return { start, end: start + n };
}

// The last `n` non-empty lines of a text.
export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-n);
}

// Moves a scroll offset by delta and keeps it inside [0, max].
export const scrollBy = (offset: number, delta: number, max: number): number => Math.max(0, Math.min(Math.max(0, max), offset + delta));
