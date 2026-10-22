import { Redis } from '@upstash/redis';

// Vercel Marketplace의 Upstash Redis를 연결하면 아래 환경변수가 자동으로 들어와요.
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = globalThis.__redis ?? (url && token ? new Redis({ url, token }) : null);

const K = { players: 'lol:players', matches: 'lol:matches', current: 'lol:current', ver: 'lol:ver', sel: 'lol:sel' };
const MAX_MATCHES = 5000;
const MAX_PLAYERS = 60;

const cleanName = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : null);
const cleanNames = (a, max) => (Array.isArray(a) ? [...new Set(a.map(cleanName).filter(Boolean))].slice(0, max) : null);
const bad = res => res.status(400).json({ error: 'bad_request' });
const readPlayers = async () => (await redis.get(K.players)) || [];
// 오늘 할 사람: Redis 정렬 집합(점수 = 고른 시각)이라 고른 순서대로 나오고, 넣기·빼기가 한 명 단위로 바로 반영돼요.
// 목록을 읽어서 고친 뒤 통째로 저장하면 동시에 누른 요청끼리 서로 덮어써서 사람이 사라졌어요.
const readSelected = async () => (await redis.zrange(K.sel, 0, -1)).map(String);
async function readMatches() {
  const hash = await redis.hgetall(K.matches);
  return Object.entries(hash || {})
    .map(([id, m]) => ({ id, ...(typeof m === 'string' ? JSON.parse(m) : m) }))
    .sort((a, b) => a.t - b.t);
}
async function readState() {
  const [players, matches, current, ver, selected] = await Promise.all([readPlayers(), readMatches(), redis.get(K.current), redis.get(K.ver), readSelected()]);
  return { players, matches, current: current || null, selected, ver: Number(ver) || 0 };
}

// RECORD_PIN 환경변수를 넣으면 기록·수정할 때 비밀번호가 필요해요. 안 넣으면 누구나 기록 가능.
function pinOk(req) {
  const pin = process.env.RECORD_PIN;
  if (!pin) return true;
  let got = req.headers['x-pin'] || '';
  try { got = decodeURIComponent(got); } catch {}
  return got === pin;
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (!redis) return res.status(503).json({ error: 'no_db' });
  try {
    if (req.method === 'GET') {
      // 화면은 5초마다 물어봐요. 바뀐 게 없으면 Redis 명령 1번으로 끝내서 무료 한도를 아껴요.
      const v = new URL(req.url, 'http://local').searchParams.get('v');
      if (v !== null) {
        const ver = Number(await redis.get(K.ver)) || 0;
        if (String(ver) === v) return res.status(200).json({ same: true, ver });
      }
      return res.status(200).json(await readState());
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    if (!pinOk(req)) return res.status(401).json({ error: 'pin_required' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    let id, dup = false;
    switch (b.action) {
      case 'addPlayers': {
        const names = cleanNames(b.names, MAX_PLAYERS);
        if (!names?.length) return bad(res);
        const players = await readPlayers();
        for (const n of names) if (!players.includes(n) && players.length < MAX_PLAYERS) players.push(n);
        await redis.set(K.players, players);
        break;
      }
      case 'removePlayer': {
        const name = cleanName(b.name);
        if (!name) return bad(res);
        await redis.set(K.players, (await readPlayers()).filter(p => p !== name));
        await redis.zrem(K.sel, name);
        break;
      }
      case 'select': {
        // 오늘 할 사람 넣기/빼기. 누른 사람만 넣고 빼서, 여럿이 동시에 눌러도 서로 안 지워져요.
        const names = cleanNames(b.names, MAX_PLAYERS);
        if (!names?.length) return bad(res);
        if (b.on === false) await redis.zrem(K.sel, ...names);
        else { const now = Date.now(); await redis.zadd(K.sel, { nx: true }, ...names.map((member, i) => ({ score: now + i, member }))); } // 이미 있으면 순서 유지
        break;
      }
      case 'renamePlayer': {
        // 이미 있는 이름으로 바꾸면 두 사람 전적이 하나로 합쳐져요 (오타로 갈라진 전적 정리용).
        const from = cleanName(b.from), to = cleanName(b.to);
        if (!from || !to || from === to) return bad(res);
        const swap = arr => [...new Set(arr.map(p => (p === from ? to : p)))];
        const swapGame = g => ({ ...g, blue: swap(g.blue), red: swap(g.red) });
        const both = g => [...g.blue, ...g.red].includes(from) && [...g.blue, ...g.red].includes(to);
        const [matches, cur] = await Promise.all([readMatches(), redis.get(K.current)]);
        // 같은 판에 둘 다 뛴 적이 있거나 지금 팀에 둘 다 있으면 서로 다른 사람이라 합칠 수 없어요.
        if (matches.some(both) || (cur?.blue && cur?.red && both(cur))) {
          return res.status(422).json({ error: 'played_together' });
        }
        const players = await readPlayers();
        await redis.set(K.players, players.includes(to) ? players.filter(p => p !== from) : players.map(p => (p === from ? to : p)));
        const changed = {};
        for (const { id: mid, ...m } of matches) {
          if (m.blue.includes(from) || m.red.includes(from)) changed[mid] = swapGame(m);
        }
        if (Object.keys(changed).length) await redis.hset(K.matches, changed);
        if (cur?.blue && cur?.red) await redis.set(K.current, swapGame(cur));
        const score = await redis.zscore(K.sel, from); // 오늘 할 사람에 있었으면 같은 자리에 새 이름으로
        if (score != null) { await redis.zadd(K.sel, { nx: true }, { score: Number(score), member: to }); await redis.zrem(K.sel, from); }
        break;
      }
      case 'addMatch': {
        const m = b.match || {}, blue = cleanNames(m.blue, 10), red = cleanNames(m.red, 10);
        if (!blue?.length || !red?.length || !['blue', 'red'].includes(m.win)) return bad(res);
        const matches = await readMatches();
        if (matches.length >= MAX_MATCHES) return res.status(409).json({ error: 'full' });
        // round는 그 판을 가리키는 번호(팀을 짠 시각)예요. 같은 판은 두 사람이 동시에 눌러도 먼저 온 기록 하나만 남겨요.
        // "같은 팀으로 한 판 더"는 새 round라서 같은 팀·같은 결과여도 따로 기록돼요.
        const now = Date.now(), round = Number(m.round) || 0;
        const prev = round && matches.find(x => x.round === round);
        if (prev) { id = prev.id; dup = true; break; }
        id = now.toString(36) + Math.random().toString(36).slice(2, 7);
        await redis.hset(K.matches, { [id]: { t: now, blue, red, win: m.win, ...(round && { round }) } });
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
        const t = Number(c.t) || Date.now();
        await redis.set(K.current, { blue, red, t, round: Number(c.round) || t });
        break;
      }
      default:
        return bad(res);
    }
    if (!dup) await redis.incr(K.ver);
    return res.status(200).json({ id, dup, ...(await readState()) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
