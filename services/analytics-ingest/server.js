// vsf analytics ingest: accepts OTLP/HTTP from Claude Code and Codex and stores
// every payload untouched in Postgres. Parsing happens later, on the server side.
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import pg from 'pg';

const PORT = Number(process.env.PORT || 4318);
const TOKEN = process.env.INGEST_TOKEN;
const MAX_BYTES = Number(process.env.MAX_BODY_BYTES || 20 * 1024 * 1024);

if (!TOKEN || TOKEN.length < 24) {
  console.error('INGEST_TOKEN must be set (24+ characters).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const SCHEMA = `
create table if not exists otlp_raw (
  id           bigserial primary key,
  received_at  timestamptz not null default now(),
  signal       text not null,
  source       text,
  user_agent   text,
  content_type text,
  bytes        integer not null,
  body_json    jsonb,
  body_raw     bytea
);
create index if not exists otlp_raw_received_at on otlp_raw (received_at);
create index if not exists otlp_raw_signal on otlp_raw (signal, received_at);
`;

const SIGNALS = { '/v1/logs': 'logs', '/v1/metrics': 'metrics', '/v1/traces': 'traces' };

function authorized(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(buf, encoding) {
  if (encoding === 'gzip') return zlib.gunzipSync(buf);
  if (encoding === 'deflate') return zlib.inflateSync(buf);
  if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  return buf;
}

function reply(res, status, isProto, body) {
  if (isProto) {
    // An empty protobuf message is a valid OTLP success response.
    res.writeHead(status, { 'content-type': 'application/x-protobuf' });
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    try {
      await pool.query('select 1');
      return reply(res, 200, false, { ok: true });
    } catch {
      return reply(res, 503, false, { ok: false });
    }
  }

  const signal = SIGNALS[path];
  if (req.method !== 'POST' || !signal) return reply(res, 404, false, { error: 'not found' });

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
  const isProto = contentType === 'application/x-protobuf';
  if (!authorized(req)) return reply(res, 401, isProto, { error: 'unauthorized' });

  try {
    const body = decode(await readBody(req), req.headers['content-encoding']);
    let json = null;
    if (!isProto) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = null;
      }
    }
    await pool.query(
      `insert into otlp_raw (signal, source, user_agent, content_type, bytes, body_json, body_raw)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        signal,
        req.headers['x-vsf-source'] || null,
        req.headers['user-agent'] || null,
        contentType || null,
        body.length,
        json,
        json ? null : body,
      ],
    );
    return reply(res, 200, isProto, {});
  } catch (err) {
    console.error(`[ingest] ${signal} failed: ${err.message}`);
    return reply(res, err.status || 500, isProto, { error: 'ingest failed' });
  }
});

await pool.query(SCHEMA);
server.listen(PORT, () => console.log(`vsf analytics ingest listening on ${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
