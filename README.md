# VoidShift

One CLI for the Void dev tools. Install it once, then add the tools you want.

> Early and macOS only. Nothing is published yet.

## Tools

| Tool | What it does |
|---|---|
| `awake` | Keeps your Mac running, on battery and with the lid closed, with guardrails |
| `skills` | Installs a shared skill pack into Claude Code and Codex |
| `agents` | Runs configured agents in the background off Linear labels |
| `memory` | A markdown memory vault, recalled into Claude Code and Codex |

Agents run on your own Claude Code or Codex login. VoidShift never reads or
stores your credentials; it only starts the official CLIs you already have.

## Usage

```sh
npm i -g @devvoid/voidshift
voidshift doctor
voidshift tools
voidshift add awake
```

## Development

```sh
pnpm install
pnpm test
node packages/cli/src/main.ts doctor
```

Node 22.18 or newer runs the TypeScript sources directly.

## License

Apache-2.0. See [LICENSE](LICENSE).
