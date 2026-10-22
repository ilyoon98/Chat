// 로컬 테스트용 서버: Redis 대신 .dev-data.json 파일에 저장해요. 서버를 껐다 켜도 기록이 남아요. (배포에는 쓰이지 않음)
// 실행: npm run dev  →  http://localhost:3000   (PORT, DEV_DATA 환경변수로 포트와 저장 파일을 바꿀 수 있어요)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.DEV_DATA || new URL('./.dev-data.json', import.meta.url);
const kv = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) kv.set(k, v?.__hash ? new Map(Object.entries(v.__hash)) : v);
} catch {}
const save = () => writeFileSync(file, JSON.stringify(Object.fromEntries([...kv].map(([k, v]) => [k, v instanceof Map ? { __hash: Object.fromEntries(v) } : v]))));

globalThis.__redis = {
  async get(k) { return kv.get(k) ?? null; },
  async set(k, v) { kv.set(k, structuredClone(v)); save(); return 'OK'; },
  async hgetall(k) { const h = kv.get(k); return h ? Object.fromEntries(h) : null; },
  async hset(k, obj) { const h = kv.get(k) ?? new Map(); for (const [f, v] of Object.entries(obj)) h.set(f, structuredClone(v)); kv.set(k, h); save(); return 1; },
  async hdel(k, f) { const n = kv.get(k)?.delete(f) ? 1 : 0; save(); return n; },
  async incr(k) { const n = (kv.get(k) ?? 0) + 1; kv.set(k, n); save(); return n; },
};
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
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(await readFile(new URL('./index.html', import.meta.url)));
}).listen(port, () => console.log(`http://localhost:${port}`));
