# VoidShift

One CLI for the Void dev tools. Install it once, run `vsf` (short for
`voidshift`), pick the tools you want, and it sets each one up with good
defaults you can change. Everything setup does can be seen and changed later
from the command line.

> Early release. macOS and Linux (awake is macOS only); Windows is next.

```sh
npm i -g @voidlabs.gg/voidshift
vsf setup              # pick tools and set them up
vsf setup --defaults   # take every default, ask only what has none
vsf                    # what every tool is doing (first run: setup)
vsf help               # every command; vsf <tool> help for a tool's
```

## Tools

| Tool | What it does |
|---|---|
| `awake` | Keeps your Mac running, on battery and with the lid closed, and puts sleep back when the battery runs low, the Mac gets hot, a timer ends or it restarts |
| `agents` | Agents for Claude Code and Codex, and workflows that run them in the background off your Linear cards |
| `memory` | A markdown vault of notes, recalled into Claude Code and Codex before every prompt |

### awake

```sh
vsf awake on [--until 7am | --for 6h] [--battery 20]
vsf awake status
vsf awake logs [-f]     # what the watchdog decided
vsf awake off
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
run them. A workflow starts when one of your Linear or VoidTrack cards gets a
label, or on a schedule, runs agents in order in a project (a repo on your
machine), and sends work back to the step that made it when a check fails:

```
when ENG + vs-plan:  Dev → QA  in tether-relay
```

Triggers, as `--trigger` takes them:

```
ENG:vs-plan                           # a Linear card in ENG assigned to you gets vs-plan
voidtrack:ORG:vs-start                # the same for VoidTrack (vsf agents key --voidtrack)
"cron:0 5 * * 1:Update dependencies"  # every Monday 05:00, no card, on its own branch
```

A schedule fires once when due (a missed one is made up within a day) and
`vsf agents run --workflow NAME` fires it now. The runner checks every minute, works in its own copy of the repo so
your checkout is never touched, and keeps two labels on the card as it goes: the
stage (`vs-planning`, `vs-plan-review`, `vs-dev`, `vs-qa`, then `vs-qa-verified`
or `vs-parked`) and the round (`vs-v1`, `vs-v2`). On Linear it posts the plan and
one final comment, nothing in between.

```sh
vsf agents status                  # runner, the card each workspace is on, parked cards
vsf agents run ENG-123 [--from qa] # run one card now, in this terminal
vsf agents start | stop | restart  # the background runner (stop cancels its cards)
vsf agents pause | resume          # pick up no new cards for a while
vsf agents cancel | retry ENG-123  # stop a card, or queue a parked one again
vsf agents runs | show ENG-123     # what happened, step by step
vsf agents logs [ENG-123] [-f]     # the runner log, or a card's step logs
vsf agents workflows               # workflows in the order they match
vsf agents workflow add|edit|show|rename|move|rm
vsf agents projects | project add|edit|show|rename|rm
vsf agents workspace add|list|rm   # folders of repos, each with its own queue
vsf agents homes | link DIR        # where the agents are installed
vsf agents clean                   # old worktrees and run logs
vsf agents validate [DIR]          # check the config and agent folders
```

Each workspace has one queue: cards in different workspaces run side by side,
two cards in one workspace one after the other. Projects are in the `default`
workspace until you move them:

```sh
vsf agents workspace add solvia --root ~/work/solvia   # steps carry ~/work/solvia/CONTEXT.md
vsf agents project edit erp --workspace solvia --match DS06
```

`--match` names a tracker project (or its first word, so `DS06` matches "DS06
Atleurope ERP"). A card of that project runs in the matching project, in any
workspace, before the workflow's own project is considered.

Two settings keep runs inside your Claude subscription. `vsf config set
agents.maxRuns 2` caps how many cards run at once over every workspace (0, the
default, is no cap). Every 5 minutes the runner reads your 5 hour window with
Claude Code's login, read only, and once it reaches `agents.pauseAt` percent
(90 by default, 0 turns it off) no new run starts until the window resets;
running cards finish. `vsf agents status` shows the window, and each run's
`run.json` keeps the tokens and estimated cost of every step. Naming a card,
`vsf agents run CARD`, starts it anyway.

A workflow can also be a folder you write by hand,
`~/.config/voidshift/agents/defs/NAME/agent.json`, with its prompt files next to
it. Steps are the built-in ids above or your own:

```json
{
  "triggers": [{ "source": "cron", "schedule": "0 7 * * 1-5", "task": "Morning brief" }],
  "steps": [{ "id": "brief", "prompt": "brief.md", "output": "none", "model": "haiku", "timeoutMinutes": 10 }],
  "maxRounds": 1,
  "project": "tether-relay",
  "writeBack": { "labels": true, "state": null, "comment": true }
}
```

A step's `output` is `plan`, `verdict`, `commits`, `publish` or `none`; a failed
`verdict` sends the work back to the nearest `plan` or `commits` step. `engine`,
`model` and `timeoutMinutes` fall back to the config, and `write` to true only
for `commits`. A `publish` step takes no prompt; the others take one `prompt`
file or `skill`, which must ask for a `RESULT:` line (`plan`, `commits`) or a
`VERDICT:` line (`verdict`). `writeBack` applies to card runs: `state` moves a
verified card there (`null` never moves it), `labels: false` only takes the
trigger label off, and `comment: false` skips the closing comment. Edit the file,
then `vsf agents validate`.

### memory

A folder of markdown notes, one topic per note, with an `INDEX.md` holding one
keyword line per note. Before every prompt, the words you type are matched
against the index and the best notes are handed to Claude Code or Codex. A
`memory` skill tells them how to read the vault and when to write a note:
decisions and their why, dead ends, things that are not obvious from the code.
Background agents read it for each card and save what they learn.

```sh
vsf memory status          # the vault and where recall is on
vsf memory search WORDS    # notes recall would bring up
vsf memory try "a prompt"  # exactly what recall would add to that prompt
vsf memory check           # notes missing from INDEX.md, broken links
vsf memory sync            # pull and push the vault through its git remote
vsf memory on | off        # turn recall on or off
```

To share the vault between machines, make it a git repository with a remote
named `origin` (any host; a private repository). `vsf memory sync` commits new
notes, rebases onto the remote and pushes. It also runs in the background from
the recall hook when the last sync is over ten minutes old, and the agents
runner syncs before and after every run. When a note changed on both sides,
the remote's version stays and this machine's copy is saved beside it as
`note.conflict-<machine>-<time>.md`, so nothing is lost.

Setup creates a vault at `~/memory` or uses one you already have. Codex asks you
to trust the recall hook once: run `/hooks` in Codex.

### Your profile

Every agent run carries your profile, on any machine, without touching your
Claude or Codex folder. `vsf agents profile init` creates
`~/.config/voidshift/agents/profile/`:

- `RULES.md` is added to every step's prompt (style, commit rules, tone).
- `claude-settings.json` is passed to Claude runs with `--settings`, so hooks
  come along. `{{profile}}` stands for the folder, so hook scripts can live in it.

Setup also asks what the runner does to agent commits before it pushes them:
remove AI co-author lines, and add `Signed-off-by` for repos that ask for a
DCO. Only the new commits of that step are rewritten, never pushed ones.

## What to know

- **Your own logins.** Agents run the official `claude` and `codex` CLIs you
  already use, signed in with your own account. VoidShift never reads or
  stores those credentials. The Linear API key for the runner lives in your
  macOS Keychain, or on Linux in `~/.config/voidshift/agents/secrets.json`
  (mode 0600).
- **Trust.** The Dev agent can run shell commands inside its copy of the repo
  so it can install and test. Review its pull requests like any other.
- **Your config** lives in `~/.config/voidshift`.
- **Linux.** The runner is a systemd user timer. Run
  `sudo loginctl enable-linger $USER` so it keeps going after you log out.
  Agents there run with permissions skipped (`--dangerously-skip-permissions`
  for Claude, `--dangerously-bypass-approvals-and-sandbox` for Codex), so no
  step ever waits on a prompt and the runner's user account is the boundary.
  Run it as a dedicated user with no sudo that holds only the keys it needs,
  never as root, and enable lingering for it from an admin account
  (`sudo loginctl enable-linger <user>`). `vsf doctor` warns when the runner
  user has sudo. A step that fails shows its error in the run log, on the card
  and in Discord.

```sh
vsf doctor                     # check everything is set up, and whether an update is out
vsf config [tool]              # every saved setting
vsf config set KEY VALUE       # e.g. vsf config set agents.models.dev opus
vsf config edit [tool]         # edit settings in $EDITOR, checked before saving
vsf update                     # update VoidShift and every tool you added
vsf tools                      # list tools

Read commands take `--json`. Workflow and project names can be shortened to
any unique start, e.g. `tether` for `tether-relay-build`.
```

## Development

```sh
pnpm install
pnpm test
node packages/cli/src/main.ts
```

Node 22.18 or newer runs the TypeScript sources directly. Each package
releases on its own: bump its `package.json` and push `agents-v0.5.0` (or
`cli-v`, `memory-v`, `awake-v`), and CI publishes only that package. A plain
`v*` tag publishes all four at one version. Tools declare the CLI contract
they were built for; a CLI that is too old refuses to load them and says to
run `vsf update`.

## License

Apache-2.0. See [LICENSE](LICENSE).
