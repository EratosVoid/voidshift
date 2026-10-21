import * as p from '@clack/prompts';
import type { Choice, Ui } from './tool.ts';

export class Cancelled extends Error {}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled. Nothing after this point was changed.');
    throw new Cancelled();
  }
  return value as Exclude<T, symbol>;
}

export const ui: Ui = {
  info: (line) => p.log.info(line),
  warn: (line) => p.log.warn(line),
  async text(message, o = {}) {
    return unwrap(await p.text({ message, initialValue: o.initial, placeholder: o.placeholder, validate: o.validate ? (v) => o.validate!(v ?? '') : undefined }));
  },
  async secret(message, validate) {
    return unwrap(await p.password({ message, validate: validate ? (v) => validate(v ?? '') : undefined }));
  },
  async confirm(message, initial = true) {
    return unwrap(await p.confirm({ message, initialValue: initial }));
  },
  async select<T extends string>(message: string, choices: Choice<T>[], initial?: T) {
    return unwrap(await p.select<T>({ message, options: choices as never, initialValue: initial }));
  },
  async multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[] = []) {
    return unwrap(await p.multiselect<T>({ message, options: choices as never, initialValues: initial, required: false }));
  },
  async search<T extends string>(message: string, choices: Choice<T>[], placeholder?: string, initial?: T) {
    return unwrap(
      await p.autocomplete<T>({
        message,
        options: choices as never,
        placeholder,
        initialValue: initial,
        maxItems: 8,
        filter: (q, o) => `${o.label ?? ''} ${o.hint ?? ''}`.toLowerCase().includes(q.toLowerCase()),
      }),
    );
  },
  async path(message, o = {}) {
    return unwrap(await p.path({ message, directory: true, initialValue: o.initial, validate: o.validate ? (v) => o.validate!(v ?? '') : undefined }));
  },
};

const shown = (v: string | boolean | string[], choices?: Choice<string>[]) => {
  const label = (x: string) => choices?.find((c) => c.value === x)?.label ?? x;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return Array.isArray(v) ? v.map(label).join(', ') || 'none' : label(v);
};

// `vsf setup --defaults`: every prompt with a default takes it and says so.
// Prompts with no sensible default (a secret, a path) still ask.
export const defaultsUi: Ui = {
  info: ui.info,
  warn: ui.warn,
  async text(message, o = {}) {
    if (o.initial === undefined || o.validate?.(o.initial)) return ui.text(message, o);
    p.log.info(`${message}  ${o.initial}`);
    return o.initial;
  },
  secret: ui.secret,
  async confirm(message, initial = true) {
    p.log.info(`${message}  ${shown(initial)}`);
    return initial;
  },
  async select<T extends string>(message: string, choices: Choice<T>[], initial?: T) {
    if (initial === undefined || !choices.some((c) => c.value === initial)) return ui.select(message, choices, initial);
    p.log.info(`${message}  ${shown(initial, choices)}`);
    return initial;
  },
  async multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[] = []) {
    p.log.info(`${message}  ${shown(initial, choices)}`);
    return initial;
  },
  async search<T extends string>(message: string, choices: Choice<T>[], placeholder?: string, initial?: T) {
    if (initial === undefined || !choices.some((c) => c.value === initial)) return ui.search(message, choices, placeholder, initial);
    p.log.info(`${message}  ${shown(initial, choices)}`);
    return initial;
  },
  path: ui.path,
};
