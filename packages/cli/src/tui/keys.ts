// Key batching. A terminal can hand over several keys in one chunk (fast typing,
// key repeat, a paste). Ink hands a plain-text chunk such as "\r\r" to useInput
// as one key and runs a burst of keys without letting the screen update between
// them, so only one takes effect. This splits a chunk into single keys and
// delivers them one per tick.
import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';

const ESC = '\u001b';
const PASTE_START = '\u001b[200~';

// Length of the escape sequence starting at s[i] (s[i] is ESC).
function escapeLength(s: string, i: number): number {
  let j = i + 1;
  if (j >= s.length) return 1;
  if (s[j] === ESC) {
    // ESC ESC [ ... : a double-prefixed sequence. Otherwise a lone ESC.
    if (s[j + 1] !== '[' && s[j + 1] !== 'O') return 1;
    j++;
  }
  const kind = s[j];
  if (kind === '[') {
    j++;
    if (s[j] === '[') j++;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      j++;
      if (c >= 0x40 && c <= 0x7e) return j - i;
    }
    return s.length - i;
  }
  if (kind === 'O') {
    j++;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      j++;
      if (c >= 0x40 && c <= 0x7e) return j - i;
    }
    return s.length - i;
  }
  // ESC plus one character (alt+key).
  return j + (s.codePointAt(j)! > 0xffff ? 2 : 1) - i;
}

// Splits a raw input chunk into single keys: escape sequences (\x1b[C, \x1bOA),
// a lone \x1b, \r, \t, control bytes and each printable character. A chunk with
// a bracketed paste is left whole.
export function splitKeys(chunk: string): string[] {
  if (chunk.includes(PASTE_START)) return [chunk];
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === ESC) {
      const n = escapeLength(chunk, i);
      keys.push(chunk.slice(i, i + n));
      i += n;
    } else {
      const n = chunk.codePointAt(i)! > 0xffff ? 2 : 1;
      keys.push(chunk.slice(i, i + n));
      i += n;
    }
  }
  return keys;
}

interface Readable {
  read(): unknown;
  emit(event: string): boolean;
}

// Makes the stdin Ink reads hand over one key per tick. While `keepWhole()` is
// true (a text input has focus) chunks go through unsplit, so typed or pasted
// text reaches the input as today.
export function useKeyBatching(keepWhole: () => boolean): void {
  const { stdin } = useStdin();
  const whole = useRef(keepWhole);
  whole.current = keepWhole;
  useEffect(() => {
    const s = stdin as unknown as Readable;
    const original = s.read;
    const queue: string[] = [];
    let gate = false;
    s.read = function (this: unknown): unknown {
      if (gate) return null;
      let item: string | undefined = queue.shift();
      if (item === undefined) {
        const raw = original.call(s);
        if (raw === null || raw === undefined) return raw ?? null;
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
        const keys = whole.current() ? [text] : splitKeys(text);
        item = keys[0];
        queue.push(...keys.slice(1));
        if (item === undefined) return null;
      }
      gate = true;
      setTimeout(() => {
        gate = false;
        s.emit('readable');
      }, 0);
      return item;
    };
    return () => {
      s.read = original;
    };
  }, [stdin]);
}
