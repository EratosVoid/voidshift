# Tools

Each folder here is one tool the `voidshift` CLI can add, published as its own
`@voidlabs.gg/voidshift-<name>` package and pulled in on `voidshift add <name>`.

A tool implements the contract in `packages/cli/src/tool.ts`: install,
uninstall, and health checks that `voidshift doctor` runs.

Planned for the macOS MVP, in build order:

| Tool | What it does |
|---|---|
| `awake` | Keeps the Mac running, on battery and with the lid closed, with guardrails |
| `skills` | Installs the shared skill pack into Claude Code and Codex |
| `agents` | Runs configured agents in the background off Linear labels |
| `memory` | Markdown memory vault, recalled into Claude Code and Codex |
