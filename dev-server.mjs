// 로컬 테스트용 서버: Redis 대신 .dev-data.json 파일에 저장해요. 서버를 껐다 켜도 기록이 남아요. (배포에는 쓰이지 않음)
// 실행: npm run dev  →  http://localhost:3000
// 환경변수: PORT(포트), DEV_DATA(저장 파일), DEV_LATENCY(Redis 명령마다 늦출 ms — 실제 서버처럼 동시에 누르는 상황 시험용)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRedis, zset } from './dev-redis.mjs';

const file = process.env.DEV_DATA || new URL('./.dev-data.json', import.meta.url);
const kv = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8'))))
    kv.set(k, v?.__hash ? new Map(Object.entries(v.__hash)) : v?.__zset ? zset(Object.entries(v.__zset)) : v);
} catch {}
const save = () => writeFileSync(file, JSON.stringify(Object.fromEntries([...kv].map(([k, v]) =>
  [k, v instanceof Map ? { [v.isZ ? '__zset' : '__hash']: Object.fromEntries(v) } : v]))));
const redis = createRedis(kv, save); // 가짜 Redis는 dev-redis.mjs에 있어요(시험도 같이 써요)
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
