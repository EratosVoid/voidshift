// Structural copy of the contract in packages/cli/src/tool.ts, so the tool
// builds without depending on the CLI package.

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
  selfCommand: string[];
  log: (line: string) => void;
}

export type ToolCommand = (args: string[], ctx: ToolContext) => Promise<number>;

export interface Tool {
  name: string;
  summary: string;
  install(ctx: ToolContext): Promise<void>;
  uninstall(ctx: ToolContext): Promise<void>;
  checks(ctx: ToolContext): Promise<Check[]>;
  commands?: Record<string, ToolCommand>;
}
