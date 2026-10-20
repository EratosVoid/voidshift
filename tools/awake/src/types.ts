// Structural copy of the contract in packages/cli/src/tool.ts, so the tool
// builds without depending on the CLI package.

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

// Prompts a tool may use while it installs. The CLI renders them; tools stay
// free of UI dependencies. Every prompt throws Cancelled on Ctrl+C.
export interface Ui {
  info(line: string): void;
  warn(line: string): void;
  text(message: string, o?: { initial?: string; placeholder?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  secret(message: string, validate?: (v: string) => string | undefined): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: Choice<T>[], initial?: T): Promise<T>;
}

export interface ToolContext {
  home: string;
  configDir: string;
  // How to invoke this CLI again, e.g. from a launchd job.
  selfCommand: string[];
  log: (line: string) => void;
  ui: Ui;
}

export type ToolCommand = (args: string[], ctx: ToolContext) => Promise<number>;

export interface Tool {
  name: string;
  summary: string;
  // Interactive setup; safe to run again to reconfigure.
  install(ctx: ToolContext): Promise<void>;
  uninstall(ctx: ToolContext): Promise<void>;
  checks(ctx: ToolContext): Promise<Check[]>;
  commands?: Record<string, ToolCommand>;
}
