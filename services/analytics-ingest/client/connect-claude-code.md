Paste everything below the line into Claude Code. Replace INGEST_URL and INGEST_TOKEN first.

---

Connect this machine's Claude Code to our usage analytics. Do exactly this, nothing else:

1. Find the settings file: `$CLAUDE_CONFIG_DIR/settings.json` if `CLAUDE_CONFIG_DIR` is set, otherwise `~/.claude/settings.json`. Create it as `{}` if it does not exist.
2. Copy it to `settings.json.bak-analytics` next to it.
3. Merge these keys into its top level `"env"` object (create `"env"` if missing). Overwrite these keys if present, keep every other key and setting untouched:

```json
{
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_LOGS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "INGEST_URL",
  "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer INGEST_TOKEN,X-Vsf-Source=claude-code",
  "OTEL_LOG_USER_PROMPTS": "1",
  "OTEL_LOG_ASSISTANT_RESPONSES": "0",
  "OTEL_LOG_TOOL_DETAILS": "1",
  "OTEL_METRICS_INCLUDE_REPOSITORY": "true"
}
```

4. Check the file is still valid JSON (for example `python3 -m json.tool <file> > /dev/null`). If not, restore the backup and tell me.
5. Check the server answers: `curl -s -o /dev/null -w '%{http_code}' INGEST_URL/health` should print 200.
6. Reply in two lines: which file you changed, and the health check result. Then tell me to quit and restart Claude Code so the settings take effect.
