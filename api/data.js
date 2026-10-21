import { Redis } from '@upstash/redis';

// Vercel Marketplace의 Upstash Redis를 연결하면 아래 환경변수가 자동으로 들어와요.
const redis = globalThis.__redis ?? new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const K = { players: 'lol:players', matches: 'lol:matches', current: 'lol:current' };
const MAX_MATCHES = 5000;

const cleanName = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : null);
const cleanNames = (a, max) => (Array.isArray(a) ? [...new Set(a.map(cleanName).filter(Boolean))].slice(0, max) : null);
const bad = res => res.status(400).json({ error: 'bad_request' });

async function readState() {
  const [players, hash, current] = await Promise.all([redis.get(K.players), redis.hgetall(K.matches), redis.get(K.current)]);
  const matches = Object.entries(hash || {})
    .map(([id, m]) => ({ id, ...(typeof m === 'string' ? JSON.parse(m) : m) }))
    .sort((a, b) => a.t - b.t);
  return { players: players || [], matches, current: current || null };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await readState());
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // RECORD_PIN 환경변수를 넣으면 기록·수정할 때 비밀번호가 필요해요. 안 넣으면 누구나 기록 가능.
    const pin = process.env.RECORD_PIN;
    if (pin && req.headers['x-pin'] !== pin) return res.status(401).json({ error: 'pin_required' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    let id;
    switch (b.action) {
      case 'players': {
        const players = cleanNames(b.players, 60);
        if (!players) return bad(res);
        await redis.set(K.players, players);
        break;
      }
      case 'addMatch': {
        const m = b.match || {}, blue = cleanNames(m.blue, 10), red = cleanNames(m.red, 10);
        if (!blue?.length || !red?.length || !['blue', 'red'].includes(m.win)) return bad(res);
        if ((await redis.hlen(K.matches)) >= MAX_MATCHES) return res.status(409).json({ error: 'full' });
        id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        await redis.hset(K.matches, { [id]: { t: Date.now(), blue, red, win: m.win } });
        break;
      }
      case 'deleteMatch': {
        if (typeof b.id !== 'string' || !b.id) return bad(res);
        await redis.hdel(K.matches, b.id);
        break;
      }
      case 'current': {
        const c = b.current || {}, blue = cleanNames(c.blue, 10), red = cleanNames(c.red, 10);
        if (!blue || !red) return bad(res);
        await redis.set(K.current, { blue, red, t: Number(c.t) || Date.now() });
        break;
      }
      default:
        return bad(res);
    }
    return res.status(200).json({ id, ...(await readState()) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
