Paste everything below the line into Codex. Replace INGEST_URL and INGEST_TOKEN first.

---

Connect this machine's Codex to our usage analytics. Do exactly this, nothing else:

1. The config file is `$CODEX_HOME/config.toml` if `CODEX_HOME` is set, otherwise `~/.codex/config.toml`. Create it empty if it does not exist.
2. Copy it to `config.toml.bak-analytics` next to it.
3. If the file already has an `[otel]` table, remove that whole table (the `[otel]` line and its keys, up to the next `[` table header or the end of the file). Then append this block at the very end of the file, exactly as written, keeping the exporter on one line:

```toml
[otel]
environment = "tether"
log_user_prompt = true
exporter = { otlp-http = { endpoint = "INGEST_URL/v1/logs", protocol = "json", headers = { "Authorization" = "Bearer INGEST_TOKEN", "X-Vsf-Source" = "codex" } } }
```

4. Check the file still parses: `python3 -c "import tomllib,sys; tomllib.load(open(sys.argv[1],'rb'))" <file>`. If python3 has no `tomllib` (older than 3.11), skip this check and read the file back instead to confirm the block is there once. If parsing fails, restore the backup and tell me.
5. Check the server answers: `curl -s -o /dev/null -w '%{http_code}' INGEST_URL/health` should print 200.
6. Reply in two lines: which file you changed, and the health check result. Then tell me to quit and restart Codex so the settings take effect.
