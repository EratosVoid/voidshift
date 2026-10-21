# VoidShift

One CLI for the Void dev tools. Install it once, run `voidshift`, pick the
tools you want, and it sets each one up with good defaults you can change.

> Early release. macOS only for now; Windows and Linux are next.

```sh
npm i -g @devvoid/voidshift
voidshift              # pick tools and set them up
voidshift --defaults   # take every default, ask only what has none
```

## Tools

| Tool | What it does |
|---|---|
| `awake` | Keeps your Mac running, on battery and with the lid closed, and puts sleep back when the battery runs low, the Mac gets hot, a timer ends or it restarts |
| `agents` | Agents for Claude Code and Codex, and workflows that run them in the background off your Linear cards |
| `memory` | A markdown vault of notes, recalled into Claude Code and Codex before every prompt |

### awake

```sh
voidshift awake on [--until 7am | --for 6h] [--battery 20]
voidshift awake status
voidshift awake off
```

Setup asks for your Mac password once to add a rule that allows only
`pmset -a disablesleep 0|1`. A small watchdog checks every minute and turns
sleep back on when it should. Keep a closed Mac out of a bag: with no airflow
it runs hot.

### agents

Five agents, installed into Claude Code (and Codex if you use it):

| Agent | What it does |
|---|---|
| Plan | plans a Linear card against the code |
| Plan review | checks a plan before it is published |
| Publish | posts the plan to the card and hands it over |
| Dev | implements the plan and opens a draft PR |
| QA | CI, then code review, then a usability check in a headless browser |

Use them yourself (`/vs-plan ENG-123` in Claude Code), or let a **workflow**
run them. A workflow starts when one of your Linear cards gets a label, runs
agents in order in a project (a repo on your Mac), and sends work back to the
step that made it when a check fails:

```
when ENG + vs-plan:  Dev → QA  in tether-relay
```

The runner checks Linear every minute, works in its own copy of the repo so
your checkout is never touched, and labels the card as it goes (`vs-dev-v1`,
`vs-qa-v1`, then `vs-qa-verified` or `vs-parked` with a comment saying why).

```sh
voidshift agents status        # workflows, projects, runner
voidshift agents run ENG-123   # run one card now, in this terminal
voidshift agents start | stop  # the background runner
```

### memory

A folder of markdown notes, one topic per note, with an `INDEX.md` holding one
keyword line per note. Before every prompt, the words you type are matched
against the index and the best notes are handed to Claude Code or Codex. A
`memory` skill tells them how to read the vault and when to write a note:
decisions and their why, dead ends, things that are not obvious from the code.
Background agents read it for each card and save what they learn.

```sh
voidshift memory status          # the vault and where recall is on
voidshift memory search WORDS    # notes recall would bring up
```

Setup creates a vault at `~/memory` or uses one you already have. Codex asks you
to trust the recall hook once: run `/hooks` in Codex.

## What to know

- **Your own logins.** Agents run the official `claude` and `codex` CLIs you
  already use, signed in with your own account. VoidShift never reads or
  stores those credentials. The Linear API key for the runner lives in your
  macOS Keychain.
- **Trust.** The Dev agent can run shell commands inside its copy of the repo
  so it can install and test. Review its pull requests like any other.
- **Your config** lives in `~/.config/voidshift`.

```sh
voidshift doctor   # check everything is set up, and whether an update is out
voidshift update   # update VoidShift and every tool you added
voidshift tools    # list tools
```

## Development

```sh
pnpm install
pnpm test
node packages/cli/src/main.ts
```

Node 22.18 or newer runs the TypeScript sources directly. Releases are cut by
pushing a `v*` tag; CI publishes every package at that version.

## License

Apache-2.0. See [LICENSE](LICENSE).
