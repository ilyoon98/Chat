import { Redis } from '@upstash/redis';

// Vercel Marketplace의 Upstash Redis를 연결하면 아래 환경변수가 자동으로 들어와요.
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = globalThis.__redis ?? (url && token ? new Redis({ url, token }) : null);

const K = { players: 'lol:players', matches: 'lol:matches', ver: 'lol:ver', riot: 'lol:riot', riotLock: 'lol:riot:lock', rooms: 'lol:rooms', hostSeen: 'lol:hostseen' };
// 방마다 따로인 것: 오늘 할 사람(정렬 집합), 팀 배치, 지금 보고 있는 사람(정렬 집합, 점수 = 마지막 신호 시각)
const RK = { sel: r => `lol:room:${r}:sel`, cur: r => `lol:room:${r}:cur`, seen: r => `lol:room:${r}:seen` };
const MAX_MATCHES = 5000;
const MAX_PLAYERS = 60;
const MAX_ROOMS = 10;
const HOST_AWAY = 10 * 6e4;   // 방장 신호가 10분 끊기면 방장 자리가 비어요
const VIEW_FRESH = 40e3;      // 화면은 15초마다 신호를 보내요. 40초 안에 신호가 있으면 '보고 있는 사람'
const ROOM_IDLE = 12 * 36e5;  // 12시간 동안 아무 일 없는 방은 정리해요

// ---------- Riot API (솔랭 티어) ----------
// RIOT_API_KEY 환경변수에 developer.riotgames.com에서 받은 키를 넣어요. 키는 서버에서만 써서 화면 코드에는 안 보여요.
const RIOT_PLATFORM = 'kr', RIOT_REGION = 'asia';
const RIOT_STALE = 6 * 36e5; // 이보다 오래된 티어는 누가 사이트를 열 때 새로 불러와요
const RIOT_FORCE_GAP = 10 * 6e4; // 새로고침 버튼은 10분에 한 번까지 (개발 키는 2분에 100번 제한)
class RiotError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
async function riot(host, path) {
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { 'X-Riot-Token': process.env.RIOT_API_KEY } });
  if (r.status === 404) return null;
  if (!r.ok) throw new RiotError(r.status === 429 ? 'riot_busy' : r.status === 401 || r.status === 403 ? 'riot_key' : 'riot_down', r.status);
  return r.json();
}
async function riotAccount(id) {
  const [name, tag] = id.split('#');
  const a = await riot(RIOT_REGION, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  return a && { id: `${a.gameName}#${a.tagLine}`, puuid: a.puuid };
}
async function riotSolo(puuid) {
  const s = (await riot(RIOT_PLATFORM, `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`))?.find(e => e.queueType === 'RANKED_SOLO_5x5');
  return s ? { tier: s.tier, rank: s.rank, lp: s.leaguePoints, w: s.wins, l: s.losses } : null; // null = 이번 시즌 솔랭 배치 전(언랭)
}
// 계정을 못 찾으면 null. PUUID는 API 키(앱)마다 달라서, 키를 바꾸면 예전 PUUID가 400으로 거절돼요. 그땐 Riot ID로 다시 찾아요.
async function riotLookup(e) {
  let acc = e.puuid ? e : await riotAccount(e.id);
  if (!acc) return null;
  let solo;
  try { solo = await riotSolo(acc.puuid); } catch (err) {
    if (err.status !== 400 || !e.puuid) throw err;
    if (!(acc = await riotAccount(e.id))) return null;
    solo = await riotSolo(acc.puuid);
  }
  return { id: acc.id, puuid: acc.puuid, solo, at: Date.now() };
}
// "Hide on bush #KR1" → "Hide on bush#KR1"
const cleanRiotId = v => { const m = typeof v === 'string' && v.trim().match(/^([^#]{1,16}?)\s*#\s*([^\s#]{1,5})$/u); return m ? `${m[1].trim()}#${m[2]}` : null; };
// 이름 → { id: 'Riot ID', puuid, solo, at }. 한 사람씩 따로 저장하는 해시라서 동시에 고쳐도 서로 안 덮어써요.
async function readRiot() {
  const hash = await redis.hgetall(K.riot);
  return Object.fromEntries(Object.entries(hash || {}).map(([n, e]) => [n, typeof e === 'string' ? JSON.parse(e) : e]));
}
// 오래된 사람부터 10명씩, 0.6초에 10번 넘지 않게 불러와요(개발 키 제한: 1초 20번). 몇 명 새로 불러왔는지 돌려줘요.
async function refreshRiot(gap) {
  const now = Date.now();
  if (now - (Number(await redis.get(K.riotLock)) || 0) < 60e3) return 0; // 여러 명이 동시에 열어도 한 번만
  const stale = Object.entries(await readRiot()).filter(([, e]) => now - (e.at || 0) >= gap).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  if (!stale.length) return 0;
  await redis.set(K.riotLock, now);
  const done = {};
  try {
    for (let i = 0; i < stale.length; i += 10) {
      const chunk = stale.slice(i, i + 10);
      const got = await Promise.all([...chunk.map(([, e]) => riotLookup(e)), new Promise(r => setTimeout(r, 600))]);
      // 계정을 못 찾으면(이름을 바꿨거나 키가 바뀜) 예전 티어를 두고 시각만 바꿔서 계속 다시 묻지 않게 해요.
      chunk.forEach(([n, e], j) => { done[n] = got[j] ?? { ...e, at: now }; });
    }
  } catch (err) {
    if (!(err instanceof RiotError) || !Object.keys(done).length) throw err; // 중간에 막히면 거기까지만 저장
  } finally {
    await redis.set(K.riotLock, 0);
  }
  await redis.hset(K.riot, done);
  return Object.keys(done).length;
}

const cleanName = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : null);
const cleanNames = (a, max) => (Array.isArray(a) ? [...new Set(a.map(cleanName).filter(Boolean))].slice(0, max) : null);
const bad = res => res.status(400).json({ error: 'bad_request' });
const cleanId = v => (typeof v === 'string' && /^[a-z0-9]{6,32}$/.test(v) ? v : null); // 기기 id·방 id
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
const readPlayers = async () => (await redis.get(K.players)) || [];
// 오늘 할 사람: Redis 정렬 집합(점수 = 고른 시각)이라 고른 순서대로 나오고, 넣기·빼기가 한 명 단위로 바로 반영돼요.
// 목록을 읽어서 고친 뒤 통째로 저장하면 동시에 누른 요청끼리 서로 덮어써서 사람이 사라졌어요.
const readSelected = async room => (await redis.zrange(RK.sel(room), 0, -1)).map(String);
async function readMatches() {
  const hash = await redis.hgetall(K.matches);
  return Object.entries(hash || {})
    .map(([id, m]) => ({ id, ...parse(m) }))
    .sort((a, b) => a.t - b.t);
}
// 방 목록: { id, name, hostId, hostNick, createdAt, lastActive, hostAlive }. 12시간 동안 조용한 방은 빼고 보여줘요.
async function readRooms() {
  const [rooms, seen] = await Promise.all([redis.hgetall(K.rooms), redis.hgetall(K.hostSeen)]), now = Date.now();
  return Object.entries(rooms || {}).map(([id, r]) => {
    const v = parse(r), hs = Number(seen?.[id]) || 0;
    return { id, ...v, hostAlive: !!v.hostId && now - hs < HOST_AWAY, idle: now - Math.max(v.lastActive || 0, hs) };
  }).filter(r => r.idle < ROOM_IDLE).sort((a, b) => a.createdAt - b.createdAt).map(({ idle, ...r }) => r);
}
const saveRoom = ({ id, hostAlive, ...r }) => redis.hset(K.rooms, { [id]: r });
async function dropRoom(id) {
  await redis.hdel(K.rooms, id); await redis.hdel(K.hostSeen, id);
  await redis.del(RK.sel(id), RK.cur(id), RK.seen(id));
}
async function readState(room) {
  const [players, matches, ver, riot, rooms] = await Promise.all([readPlayers(), readMatches(), redis.get(K.ver), readRiot(), readRooms()]);
  const r = rooms.find(x => x.id === room);
  const roomState = r ? { id: r.id, selected: await readSelected(r.id), current: (await redis.get(RK.cur(r.id))) || null } : null;
  return { players, matches, riot, rooms, room: roomState, ver: Number(ver) || 0 };
}
// 지금 보고 있다는 신호(15초마다). 멤버는 "기기id|닉네임"이고, 방장이면 방장 신호 시각도 남겨요.
async function heartbeat(room, me, nick, claimsHost) {
  const key = RK.seen(room), now = Date.now();
  await redis.zadd(key, { score: now, member: `${me}|${nick}` });
  await redis.zremrangebyscore(key, 0, now - HOST_AWAY);
  if (claimsHost && parse(await redis.hget(K.rooms, room))?.hostId === me) await redis.hset(K.hostSeen, { [room]: now });
  const raw = await redis.zrange(key, 0, -1, { withScores: true }), seen = new Map();
  for (let i = 0; i < raw.length; i += 2) {
    const [id, ...n] = String(raw[i]).split('|'), at = Number(raw[i + 1]);
    if (now - at < VIEW_FRESH && !(seen.get(id)?.at > at)) seen.set(id, { id, nick: n.join('|'), at }); // 닉네임을 바꿨으면 최근 것
  }
  return [...seen.values()].sort((a, b) => a.at - b.at).map(({ id, nick }) => ({ id, nick }));
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
      // 15초마다 한 번은 hb=1로 '보고 있어요' 신호를 같이 보내고, 그 방에 지금 누가 있는지 받아 가요.
      const q = new URL(req.url, 'http://local').searchParams, v = q.get('v'), room = cleanId(q.get('room'));
      const me = cleanId(q.get('me')), nick = cleanName(q.get('nick'));
      const presence = q.get('hb') && room && me && nick ? await heartbeat(room, me, nick, q.get('host') === '1') : undefined;
      if (v !== null) {
        const ver = Number(await redis.get(K.ver)) || 0;
        if (String(ver) === v) return res.status(200).json({ same: true, ver, presence });
      }
      return res.status(200).json({ ...(await readState(room)), presence });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    // 솔랭 새로고침은 기록을 바꾸지 않아서 비밀번호 없이도 돼요.
    if (b.action !== 'refreshRiot' && !pinOk(req)) return res.status(401).json({ error: 'pin_required' });
    // 방장 확인: 기기마다 화면이 만든 id(x-device)로 구분해요. 친구끼리 쓰는 거라 로그인 없이 이 정도로 막아요.
    const me = cleanId(req.headers['x-device']), rooms = await readRooms();
    const room = rooms.find(r => r.id === cleanId(b.room)), isHost = r => !!r && !!me && r.hostId === me;
    const notHost = () => res.status(423).json({ error: 'not_host' });
    // 명단·Riot ID·기록 삭제는 모든 방이 같이 쓰는 거라 어느 방이든 방장인 사람만 바꿀 수 있어요.
    const rosterAction = ['addPlayers', 'removePlayer', 'renamePlayer', 'setRiot', 'deleteMatch'].includes(b.action);
    if (rosterAction && !rooms.some(isHost)) return notHost();
    // 그 방의 오늘 할 사람·팀 배치·승패는 그 방 방장만
    if (['select', 'current', 'addMatch', 'giveHost', 'closeRoom'].includes(b.action)) {
      if (!room) return res.status(404).json({ error: 'no_room' });
      if (!isHost(room)) return notHost();
    }
    let id, dup = false, refreshed, roomId = room?.id;
    switch (b.action) {
      case 'createRoom': {
        // 새 방을 만든 사람이 방장이에요. 오래 조용했던 방은 이때 같이 지워요.
        const nick = cleanName(b.nick);
        if (!me || !nick) return bad(res);
        const all = Object.keys((await redis.hgetall(K.rooms)) || {});
        for (const old of all) if (!rooms.some(r => r.id === old)) await dropRoom(old);
        if (rooms.length >= MAX_ROOMS) return res.status(409).json({ error: 'rooms_full' });
        const now = Date.now();
        id = roomId = now.toString(36) + Math.random().toString(36).slice(2, 7);
        await saveRoom({ id, name: cleanName(b.name) || `${nick}의 방`, hostId: me, hostNick: nick, createdAt: now, lastActive: now });
        await redis.hset(K.hostSeen, { [id]: now });
        break;
      }
      case 'claimHost': {
        // 방장 자리가 비었을 때(방장 신호가 10분 끊김)만 가져갈 수 있어요.
        const nick = cleanName(b.nick);
        if (!room) return res.status(404).json({ error: 'no_room' });
        if (!me || !nick) return bad(res);
        if (room.hostAlive && !isHost(room)) return res.status(409).json({ error: 'host_busy' });
        await saveRoom({ ...room, hostId: me, hostNick: nick, lastActive: Date.now() });
        await redis.hset(K.hostSeen, { [room.id]: Date.now() });
        break;
      }
      case 'giveHost': {
        // 방장이 지금 보고 있는 사람 중 한 명에게 넘겨줘요.
        const to = cleanId(b.to), nick = cleanName(b.toNick);
        if (!to || !nick || to === me) return bad(res);
        await saveRoom({ ...room, hostId: to, hostNick: nick, lastActive: Date.now() });
        await redis.hset(K.hostSeen, { [room.id]: Date.now() });
        break;
      }
      case 'closeRoom': {
        await dropRoom(room.id); roomId = null;
        break;
      }
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
        for (const r of rooms) await redis.zrem(RK.sel(r.id), name);
        await redis.hdel(K.riot, name);
        break;
      }
      case 'select': {
        // 오늘 할 사람 넣기/빼기. 누른 사람만 넣고 빼서, 여럿이 동시에 눌러도 서로 안 지워져요.
        const names = cleanNames(b.names, MAX_PLAYERS);
        if (!names?.length) return bad(res);
        if (b.on === false) await redis.zrem(RK.sel(room.id), ...names);
        else { const now = Date.now(); await redis.zadd(RK.sel(room.id), { nx: true }, ...names.map((member, i) => ({ score: now + i, member }))); } // 이미 있으면 순서 유지
        await saveRoom({ ...room, lastActive: Date.now() });
        break;
      }
      case 'renamePlayer': {
        // 이미 있는 이름으로 바꾸면 두 사람 전적이 하나로 합쳐져요 (오타로 갈라진 전적 정리용).
        const from = cleanName(b.from), to = cleanName(b.to);
        if (!from || !to || from === to) return bad(res);
        const swap = arr => [...new Set(arr.map(p => (p === from ? to : p)))];
        const swapGame = g => ({ ...g, blue: swap(g.blue), red: swap(g.red) });
        const both = g => [...g.blue, ...g.red].includes(from) && [...g.blue, ...g.red].includes(to);
        const [matches, curs] = await Promise.all([readMatches(), Promise.all(rooms.map(r => redis.get(RK.cur(r.id))))]);
        // 같은 판에 둘 다 뛴 적이 있거나 어느 방 팀에 둘 다 있으면 서로 다른 사람이라 합칠 수 없어요.
        if (matches.some(both) || curs.some(c => c?.blue && c?.red && both(c))) {
          return res.status(422).json({ error: 'played_together' });
        }
        const players = await readPlayers();
        await redis.set(K.players, players.includes(to) ? players.filter(p => p !== from) : players.map(p => (p === from ? to : p)));
        const changed = {};
        for (const { id: mid, ...m } of matches) {
          if (m.blue.includes(from) || m.red.includes(from)) changed[mid] = swapGame(m);
        }
        if (Object.keys(changed).length) await redis.hset(K.matches, changed);
        for (const [i, r] of rooms.entries()) {
          if (curs[i]?.blue && curs[i]?.red) await redis.set(RK.cur(r.id), swapGame(curs[i]));
          const score = await redis.zscore(RK.sel(r.id), from); // 오늘 할 사람에 있었으면 같은 자리에 새 이름으로
          if (score != null) { await redis.zadd(RK.sel(r.id), { nx: true }, { score: Number(score), member: to }); await redis.zrem(RK.sel(r.id), from); }
        }
        const riotIds = await readRiot(); // 연결된 Riot ID도 새 이름으로 (합칠 땐 원래 있던 쪽을 둬요)
        if (riotIds[from]) { if (!riotIds[to]) await redis.hset(K.riot, { [to]: riotIds[from] }); await redis.hdel(K.riot, from); }
        break;
      }
      case 'setRiot': {
        // 명단의 한 사람에 Riot ID를 연결하고 솔랭 티어를 바로 불러와요. riotId를 비우면 연결을 끊어요.
        const name = cleanName(b.name);
        if (!name || !(await readPlayers()).includes(name)) return bad(res);
        if (!String(b.riotId ?? '').trim()) { await redis.hdel(K.riot, name); break; }
        const riotId = cleanRiotId(b.riotId);
        if (!riotId) return res.status(424).json({ error: 'bad_riot_id' });
        if (!process.env.RIOT_API_KEY) return res.status(424).json({ error: 'no_riot_key' });
        const e = await riotLookup({ id: riotId });
        if (!e) return res.status(424).json({ error: 'riot_not_found' });
        await redis.hset(K.riot, { [name]: e });
        break;
      }
      case 'refreshRiot': {
        // 화면이 열릴 때 오래된 티어가 있으면 부르고(6시간), 새로고침 버튼은 10분 지난 것만 다시 불러요.
        if (!process.env.RIOT_API_KEY) return res.status(424).json({ error: 'no_riot_key' });
        refreshed = await refreshRiot(b.force ? RIOT_FORCE_GAP : RIOT_STALE);
        if (!refreshed) dup = true; // 바뀐 게 없으면 다른 화면도 다시 받을 필요 없어요
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
        await saveRoom({ ...room, lastActive: now });
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
        await redis.set(RK.cur(room.id), { blue, red, t, round: Number(c.round) || t });
        await saveRoom({ ...room, lastActive: Date.now() });
        break;
      }
      default:
        return bad(res);
    }
    if (!dup) await redis.incr(K.ver);
    return res.status(200).json({ id, dup, refreshed, ...(await readState(roomId)) });
  } catch (e) {
    if (e instanceof RiotError) return res.status(424).json({ error: e.code });
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
