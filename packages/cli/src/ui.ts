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
  async search<T extends string>(message: string, choices: Choice<T>[], placeholder?: string) {
    return unwrap(
      await p.autocomplete<T>({
        message,
        options: choices as never,
        placeholder,
        maxItems: 8,
        filter: (q, o) => `${o.label ?? ''} ${o.hint ?? ''}`.toLowerCase().includes(q.toLowerCase()),
      }),
    );
  },
  async path(message, o = {}) {
    return unwrap(await p.path({ message, directory: true, initialValue: o.initial, validate: o.validate ? (v) => o.validate!(v ?? '') : undefined }));
  },
};
