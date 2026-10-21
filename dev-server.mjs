// 로컬 테스트용 서버: Redis 대신 메모리에 저장해요. (배포에는 쓰이지 않음)
// 실행: npm run dev  →  http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const kv = new Map();
globalThis.__redis = {
  async get(k) { return kv.get(k) ?? null; },
  async set(k, v) { kv.set(k, structuredClone(v)); return 'OK'; },
  async hgetall(k) { const h = kv.get(k); return h ? Object.fromEntries(h) : null; },
  async hset(k, obj) { const h = kv.get(k) ?? new Map(); for (const [f, v] of Object.entries(obj)) h.set(f, structuredClone(v)); kv.set(k, h); return 1; },
  async hdel(k, f) { return kv.get(k)?.delete(f) ? 1 : 0; },
  async hlen(k) { return kv.get(k)?.size ?? 0; },
};
const { default: handler } = await import('./api/data.js');

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/data')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    req.body = body ? JSON.parse(body) : {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    return handler(req, res);
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(await readFile(new URL('./index.html', import.meta.url)));
}).listen(3000, () => console.log('http://localhost:3000'));
