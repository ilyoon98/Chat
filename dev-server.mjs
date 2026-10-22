// 로컬 테스트용 서버: Redis 대신 .dev-data.json 파일에 저장해요. 서버를 껐다 켜도 기록이 남아요. (배포에는 쓰이지 않음)
// 실행: npm run dev  →  http://localhost:3000
// 환경변수: PORT(포트), DEV_DATA(저장 파일), DEV_LATENCY(Redis 명령마다 늦출 ms — 실제 서버처럼 동시에 누르는 상황 시험용)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.DEV_DATA || new URL('./.dev-data.json', import.meta.url);
const kv = new Map();
const zset = entries => Object.assign(new Map(entries), { isZ: true }); // 정렬 집합(멤버 → 점수)
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8'))))
    kv.set(k, v?.__hash ? new Map(Object.entries(v.__hash)) : v?.__zset ? zset(Object.entries(v.__zset)) : v);
} catch {}
const save = () => writeFileSync(file, JSON.stringify(Object.fromEntries([...kv].map(([k, v]) =>
  [k, v instanceof Map ? { [v.isZ ? '__zset' : '__hash']: Object.fromEntries(v) } : v]))));

const redis = {
  async get(k) { return kv.get(k) ?? null; },
  async set(k, v) { kv.set(k, structuredClone(v)); save(); return 'OK'; },
  async del(...ks) { let n = 0; for (const k of ks) if (kv.delete(k)) n++; save(); return n; },
  async hget(k, f) { return kv.get(k)?.get(f) ?? null; },
  async hgetall(k) { const h = kv.get(k); return h ? Object.fromEntries(h) : null; },
  async hset(k, obj) { const h = kv.get(k) ?? new Map(); for (const [f, v] of Object.entries(obj)) h.set(f, structuredClone(v)); kv.set(k, h); save(); return 1; },
  async hdel(k, f) { const n = kv.get(k)?.delete(f) ? 1 : 0; save(); return n; },
  async incr(k) { const n = (kv.get(k) ?? 0) + 1; kv.set(k, n); save(); return n; },
  // @upstash/redis와 같은 모양: zadd(key, [opts], {score, member}, ...)
  async zadd(k, ...args) {
    const opts = args[0] && !('member' in args[0]) ? args.shift() : {}, z = kv.get(k) ?? zset();
    let n = 0;
    for (const { score, member } of args) if (!(opts.nx && z.has(member))) { if (!z.has(member)) n++; z.set(member, score); }
    kv.set(k, z); save(); return n;
  },
  async zrem(k, ...members) { const z = kv.get(k); let n = 0; for (const m of members) if (z?.delete(m)) n++; save(); return n; },
  // zrange(key, 0, -1, { withScores: true })면 [멤버, 점수, 멤버, 점수, …]
  async zrange(k, _s, _e, opts = {}) { const z = kv.get(k); return z ? [...z].sort((a, b) => a[1] - b[1]).flatMap(([m, s]) => opts.withScores ? [m, s] : [m]) : []; },
  async zremrangebyscore(k, min, max) { const z = kv.get(k); let n = 0; for (const [m, s] of z || []) if (s >= min && s <= max) { z.delete(m); n++; } save(); return n; },
  async zscore(k, m) { return kv.get(k)?.get(m) ?? null; },
};
const latency = Number(process.env.DEV_LATENCY) || 0;
globalThis.__redis = latency
  ? Object.fromEntries(Object.entries(redis).map(([name, fn]) => [name, async (...a) => { await new Promise(r => setTimeout(r, latency)); return fn(...a); }]))
  : redis;
const { default: handler } = await import('./api/data.js');

const port = Number(process.env.PORT) || 3000;
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/data')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { req.body = body ? JSON.parse(body) : {}; } catch { res.statusCode = 400; return res.end(); }
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    return handler(req, res);
  }
  // 아이콘·미리보기 이미지
  const path = req.url.split('?')[0]; // favicon.svg?v=2처럼 뒤에 붙은 건 빼고 봐요
  const image = { '/favicon.svg': 'image/svg+xml', '/apple-touch-icon.png': 'image/png', '/og.png': 'image/png' }[path];
  if (image) { res.setHeader('content-type', image); return res.end(await readFile(new URL('.' + path, import.meta.url))); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(await readFile(new URL('./index.html', import.meta.url)));
}).listen(port, () => console.log(`http://localhost:${port}`));
