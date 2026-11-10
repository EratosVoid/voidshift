# vsf analytics ingest (prototype)

Not part of the pnpm workspace and not published to npm. Deployed by hand.

Claude Code and Codex send everything they report (OpenTelemetry over HTTP) to
this service. It checks a team token and stores each payload untouched in
Postgres. No parsing at ingest: everything is kept, and you decide later how
to read it.

## What is here

| File | Purpose |
|---|---|
| `server.js` | The ingest. `POST /v1/logs`, `/v1/metrics`, `/v1/traces`, `GET /health`. One dependency (`pg`). Creates its table on start. |
| `views.sql` | Optional example parsing: `events` (one row per event, attributes flattened), `daily_usage` (cost and tokens per person per day), `prompts`. |
| `client/claude-code-settings.json` | Env block for Claude Code. Use as managed settings (cannot be overridden) or user settings. |
| `client/codex-otel.toml` | Block to append to `~/.codex/config.toml`. |
| `client/connect-claude-code.md`, `client/connect-codex.md` | Team rollout: a block each person pastes into Claude Code or Codex, which then edits its own config. |
| `test/smoke.sh` | Posts sample payloads and checks status codes. |

## Storage

One table, `otlp_raw`: `received_at`, `signal` (logs, metrics, traces),
`source` (from the `X-Vsf-Source` header), `user_agent`, `content_type`,
`bytes`, and the payload as `body_json` (JSON requests) or `body_raw`
(protobuf or anything unparseable). Gzip, deflate and brotli bodies are
decompressed first. Each event inside carries `user.email`, `session.id`,
`organization.id`, model, cost and so on.

## Deploy on Railway

1. New project with a Postgres service and an empty service, then upload this
   folder from the repo root:
   `railway up services/analytics-ingest --path-as-root --service ingest`.
   Start command `npm start`.
2. Variables on the service: `DATABASE_URL` (reference the Postgres one),
   `INGEST_TOKEN` (random, 24+ characters, e.g. `openssl rand -hex 24`).
   Railway sets `PORT`.
3. Generate a public domain, then `INGEST_URL=https://<domain>
   INGEST_TOKEN=... sh test/smoke.sh`.
4. Replace `INGEST_HOST` and `INGEST_TOKEN` in `client/` and roll those out.

## Verified locally (2026-11-09)

- Smoke test: health, JSON logs and metrics, gzip, protobuf, bad token 401,
  unknown path 404, all pass.
- A real `claude -p` session sent with the client settings landed as three
  rows (2 metrics, 1 logs). The `events` view read user_prompt, api_request
  (cost, tokens), assistant_response, hook, plugin and MCP events, with email
  and session on each.
- Codex 0.160.0 verified against the Railway deploy: events carry user.email, conversation.id, model and prompt. The connect-codex block was run by Codex itself on a test config and the result exported correctly.
- Railway deploy verified (DevVoid project).

## Before the team rollout

- Tell the team prompts and agent commands are logged (see the handoff doc).
- The token ships to every laptop and can only write. Rotate it by changing
  `INGEST_TOKEN` and the client files together.
- Volume: one short session was about 50 KB. Plan retention (for example,
  delete raw rows older than 180 days) once real numbers are in.

## Path into vsf

`vsf add analytics` would write `client/` settings for the user (asking for
the URL and token once), `vsf analytics status` would check that the last
export landed, and the dashboard would read the views above. Out of scope for
this prototype.
