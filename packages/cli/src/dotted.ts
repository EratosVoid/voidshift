// Helpers for `vsf config`: address nested settings by a dotted key.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const isIndex = (k: string) => /^\d+$/.test(k);
const isContainer = (v: unknown): v is Obj | unknown[] => typeof v === 'object' && v !== null;

export function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (Array.isArray(cur)) {
      if (!isIndex(k) || Number(k) >= cur.length) return undefined;
      cur = cur[Number(k)];
    } else if (isObj(cur) && Object.hasOwn(cur, k)) {
      cur = cur[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Returns a new object; the input is left alone. Non-container values on the way are replaced.
// A numeric segment into an array addresses that element (memory.homes.0.dir).
export function setPath(obj: Obj, path: string[], value: unknown): Obj {
  const out = structuredClone(obj);
  let cur: Obj | unknown[] = out;
  const slot = (c: Obj | unknown[], k: string) => (Array.isArray(c) && isIndex(k) ? Number(k) : k);
  for (const k of path.slice(0, -1)) {
    const at = slot(cur, k);
    const next = (cur as Record<string | number, unknown>)[at];
    if (!isContainer(next)) (cur as Record<string | number, unknown>)[at] = {};
    cur = (cur as Record<string | number, unknown>)[at] as Obj | unknown[];
  }
  const last = path[path.length - 1];
  if (last !== undefined) (cur as Record<string | number, unknown>)[slot(cur, last)] = value;
  return out;
}

export function unsetPath(obj: Obj, path: string[]): Obj {
  const out = structuredClone(obj);
  const parent = path.length > 1 ? getPath(out, path.slice(0, -1)) : out;
  const last = path[path.length - 1];
  if (last === undefined) return out;
  if (Array.isArray(parent)) {
    if (isIndex(last) && Number(last) < parent.length) parent.splice(Number(last), 1);
  } else if (isObj(parent)) {
    delete parent[last];
  }
  return out;
}

// Arrays and empty objects are leaves.
export function flatten(obj: unknown, prefix = ''): [string, unknown][] {
  if (!isObj(obj) || Object.keys(obj).length === 0) return prefix ? [[prefix, obj]] : [];
  return Object.entries(obj).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Matched against one key segment, anchored so maxTokens, keywords and
// keyboard stay visible while apiKey, key, accessToken, clientSecret hide.
const SECRET = /key$|token$|secret|password|passphrase/i;

const last = (key: string) => key.split('.').pop() ?? key;

export function mask(key: string, value: unknown): unknown {
  return SECRET.test(last(key)) ? '****' : value;
}

// Mask secrets inside a nested value. A secret-looking key hides its whole
// subtree; arrays are walked too. `key` is the key the value sits under.
export function maskDeep(value: unknown, key = ''): unknown {
  if (key && SECRET.test(last(key))) return '****';
  if (Array.isArray(value)) return value.map((v) => maskDeep(v));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, k)]));
  return value;
}
