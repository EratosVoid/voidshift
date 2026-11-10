-- Example parsing on top of the raw table. Optional: raw rows stay the source of
-- truth, these views can be dropped and rewritten at any time.

-- One row per Claude Code or Codex event, attributes flattened into one jsonb map.
create or replace view events as
select
  r.id                                              as raw_id,
  r.source,
  to_timestamp((lr->>'timeUnixNano')::numeric / 1e9) as at,
  coalesce(attrs->>'event.name', lr->'body'->>'stringValue') as event,
  attrs->>'user.email'                              as user_email,
  attrs->>'session.id'                              as session_id,
  attrs
from otlp_raw r
cross join lateral jsonb_array_elements(r.body_json->'resourceLogs') rl
cross join lateral jsonb_array_elements(rl->'scopeLogs') sl
cross join lateral jsonb_array_elements(sl->'logRecords') lr
cross join lateral (
  select jsonb_object_agg(
           a->>'key',
           coalesce(a->'value'->>'stringValue', a->'value'->>'intValue',
                    a->'value'->>'doubleValue', a->'value'->>'boolValue', (a->'value')::text))
           as attrs
  from jsonb_array_elements(lr->'attributes') a
) x
where r.signal = 'logs' and r.body_json is not null;

-- Cost and tokens per person per day.
create or replace view daily_usage as
select
  date_trunc('day', at) as day,
  user_email,
  count(*)                                    as api_requests,
  round(sum((attrs->>'cost_usd')::numeric), 4) as cost_usd,
  sum((attrs->>'input_tokens')::bigint)        as input_tokens,
  sum((attrs->>'output_tokens')::bigint)       as output_tokens,
  sum((attrs->>'cache_read_tokens')::bigint)   as cache_read_tokens
from events
where event = 'api_request'
group by 1, 2;

-- Prompts in order, per session.
create or replace view prompts as
select at, user_email, session_id, attrs->>'prompt' as prompt
from events
where event = 'user_prompt';
