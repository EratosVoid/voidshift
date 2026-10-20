// The contract every voidshift tool implements. The CLI owns discovery,
// install and reporting; a tool only knows how to set itself up, take
// itself down and say whether it is healthy.

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface ToolContext {
  home: string;
  configDir: string;
  log: (line: string) => void;
}

export interface Tool {
  name: string;
  summary: string;
  install(ctx: ToolContext): Promise<void>;
  uninstall(ctx: ToolContext): Promise<void>;
  checks(ctx: ToolContext): Promise<Check[]>;
}
