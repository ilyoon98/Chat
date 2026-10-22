import { Redis } from '@upstash/redis';
import { createHmac, randomBytes } from 'node:crypto';

// Vercel Marketplace의 Upstash Redis를 연결하면 아래 환경변수가 자동으로 들어와요.
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = globalThis.__redis ?? (url && token ? new Redis({ url, token }) : null);

const K = { players: 'lol:players', matches: 'lol:matches', ver: 'lol:ver', riot: 'lol:riot', riotLock: 'lol:riot:lock', riotRest: 'lol:riot:rest', riotGames: 'lol:riot:games', rooms: 'lol:rooms', hostSeen: 'lol:hostseen', nicks: 'lol:nicks' };
// 방마다 따로인 것: 오늘 할 사람(정렬 집합), 팀 배치, 지금 보고 있는 사람(정렬 집합, 점수 = 마지막 신호 시각)
const RK = { sel: r => `lol:room:${r}:sel`, cur: r => `lol:room:${r}:cur`, seen: r => `lol:room:${r}:seen` };
const MAX_MATCHES = 5000;
const MAX_PLAYERS = 60;
const MAX_ROOMS = 10;
const HOST_AWAY = 10 * 6e4;   // 방장 신호가 10분 끊기면 방장 자리가 비어요
const VIEW_FRESH = 40e3;      // 화면은 15초마다 신호를 보내요. 40초 안에 신호가 있으면 '보고 있는 사람'
const ROOM_IDLE = 12 * 36e5;  // 12시간 동안 아무 일 없는 방은 정리해요
const NICK_KEEP = 30 * 864e5; // 닉네임은 30일 동안 안 쓰면 다른 사람이 가져갈 수 있어요

// ---------- Riot API (솔랭 티어 · 주 라인 · 모스트 · 숙련도) ----------
// RIOT_API_KEY 환경변수에 developer.riotgames.com에서 받은 키를 넣어요. 키는 서버에서만 써서 화면 코드에는 안 보여요.
const RIOT_PLATFORM = 'kr', RIOT_REGION = 'asia';
const RIOT_STALE = 6 * 36e5; // 이보다 오래된 정보는 누가 사이트를 열 때 새로 불러와요
const RIOT_FORCE_GAP = 10 * 6e4; // 새로고침 버튼은 10분에 한 번까지
// 키 제한은 1초 20번, 2분 100번이에요. 한 번 새로고침에 80번까지만 부르고, 부른 만큼 쉬었다가 이어서 불러요.
const RIOT_BUDGET = 80, RIOT_LINK_BUDGET = 40, RIOT_REST = 2 * 6e4;
// 주 라인·모스트는 최근 협곡 20판(솔랭·자랭·일반)으로 세요. 칼바람·아레나 같은 건 라인이 없어서 안 불러요.
const RIOT_GAMES = 20;
// 라인 추천용으로는 예전 판까지 사람당 100판을 모아 둬요. 새로고침할 때마다 새 판 + 예전 판 20판씩 거슬러 올라가요.
const RIOT_HISTORY = 100;
const RIOT_QUERIES = ['type=ranked', 'queue=400', 'queue=480', 'queue=490']; // 솔랭·자랭 / 일반 드래프트 / 신속 대전 / 빠른 대전
const RIOT_LANES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
class RiotError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
// ctx = { left: 남은 횟수, used: 부른 횟수, stop: 막힌 이유 }. 한 번 막히면 그 요청에선 더 부르지 않아요.
// 1초 20번 제한: 같은 서버에서 같이 부르는 요청끼리도 60ms씩 간격을 둬요.
let riotSlot = 0;
async function riot(host, path, ctx) {
  if (ctx.stop) throw ctx.stop;
  if (ctx.left-- <= 0) throw (ctx.stop = new RiotError('riot_busy'));
  const now = Date.now(), at = Math.max(now, riotSlot);
  riotSlot = at + 60; ctx.used = (ctx.used || 0) + 1;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { 'X-Riot-Token': process.env.RIOT_API_KEY } });
  if (r.status === 404) return null;
  if (!r.ok) throw new RiotError(r.status === 429 ? 'riot_busy' : r.status === 401 || r.status === 403 ? 'riot_key' : 'riot_down', r.status);
  return r.json();
}
// 숙련도·최근 판은 막혀도(횟수를 다 썼거나 Riot이 바쁨) 그때까지 불러온 걸 남기고, 다음 새로고침에서 이어서 불러요.
const soft = (ctx, p) => p.catch(err => {
  if (!(err instanceof RiotError) || err.code === 'riot_key') throw err;
  ctx.stop ??= err;
});
async function riotAccount(id, ctx) {
  const [name, tag] = id.split('#');
  const a = await riot(RIOT_REGION, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, ctx);
  return a && { id: `${a.gameName}#${a.tagLine}`, puuid: a.puuid };
}
async function riotSolo(puuid, ctx) {
  const s = (await riot(RIOT_PLATFORM, `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`, ctx))?.find(e => e.queueType === 'RANKED_SOLO_5x5');
  return s ? { tier: s.tier, rank: s.rank, lp: s.leaguePoints, w: s.wins, l: s.losses } : null; // null = 이번 시즌 솔랭 배치 전(언랭)
}
// 숙련도 높은 챔피언 3개: [[챔피언 번호, 레벨, 점수], …]
async function riotMastery(puuid, ctx) {
  const m = await riot(RIOT_PLATFORM, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top?count=3`, ctx);
  return (m || []).map(c => [c.championId, c.championLevel, c.championPoints]);
}
// 최근 협곡 판을 세서 주 라인·모스트를 만들어요. 한 판씩 불러온 결과는 K.riotGames에 PUUID별로 남겨서, 다음엔 새 판만 불러요.
// 남기는 모양: [매치 id, 챔피언 번호, 라인, 이김 1/0, 큐 번호, 시작 시각(초)]. 다시하기(조기 항복)는 라인을 ''로 남겨서 세지 않아요.
// 새 판을 받은 뒤 남는 횟수로 예전 판을 20판씩 더 거슬러 받아서, 사람당 100판까지 모아요(full = 더 예전 판이 없음).
async function riotGames(puuid, ctx) {
  const P = encodeURIComponent(puuid), num = id => Number(String(id).split('_')[1]) || 0;
  const saved = parse(await redis.hget(K.riotGames, puuid)) || {};
  const have = new Map((saved.g || []).map(x => [x[0], x]));
  const fetchGames = ids => Promise.all(ids.map(id => soft(ctx, riot(RIOT_REGION, `/lol/match/v5/matches/${id}`, ctx).then(m => {
    const p = m?.info?.participants?.find(x => x.puuid === puuid), t = Math.floor((m?.info?.gameStartTimestamp || 0) / 1e3);
    have.set(id, p ? [id, p.championId, p.gameEndedInEarlySurrender ? '' : p.teamPosition || '', p.win ? 1 : 0, m.info.queueId, t] : [id, 0, '', 0, 0, t]);
  }))));
  const lists = await Promise.all(RIOT_QUERIES.map(q => riot(RIOT_REGION, `/lol/match/v5/matches/by-puuid/${P}/ids?${q}&count=${RIOT_GAMES}`, ctx)));
  const ids = [...new Set(lists.flat().filter(Boolean))].sort((a, b) => num(b) - num(a)).slice(0, RIOT_GAMES);
  // 시각이 없는 예전 모양 판(최근 20판)도 다시 받아서 시각을 채워요. 그래야 거슬러 올라갈 기준이 생겨요.
  await fetchGames(ids.filter(id => !have.get(id)?.[5]));
  // 예전 판은 큐마다 "목록 몇 번째부터"(start)로 받아요. cur[i] = 그 큐에서 이미 지나온 개수.
  // (endTime으로 시각을 주면 Riot이 무시하고 최신 판을 다시 줘서, 더 받을 게 없다고 잘못 끝난 적이 있어요. v2부터 start 방식)
  // 처음엔 0부터: 큐마다 최신 20판 중 위에서 안 받은 판(다른 큐 판에 밀려서)이 있을 수 있어서, 이미 가진 판은 건너뛰며 내려가요.
  const v2 = saved.pv === 2, cur = v2 && Array.isArray(saved.cur) ? [...saved.cur] : RIOT_QUERIES.map(() => 0);
  let full = v2 && !!saved.full;
  const kept = () => [...have.values()].filter(x => x[5]).sort((a, b) => b[5] - a[5]);
  if (!full && !ctx.stop && kept().length < RIOT_HISTORY) {
    const older = await soft(ctx, Promise.all(RIOT_QUERIES.map((q, i) => riot(RIOT_REGION, `/lol/match/v5/matches/by-puuid/${P}/ids?${q}&start=${cur[i]}&count=${RIOT_GAMES}`, ctx))));
    if (older) {
      if (older.every(l => !l?.length)) full = true; // 네 큐 모두 더 예전 판이 없어요
      const more = [...new Set(older.flat().filter(Boolean))].filter(id => !have.has(id)).sort((a, b) => num(b) - num(a)).slice(0, RIOT_GAMES);
      await fetchGames(more);
      // 큐마다 앞에서부터 받아 둔 만큼만 지나가요. 이번에 20판에 못 들어 남은 예전 판은 다음에 다시 받아요.
      older.forEach((l, i) => { let k = 0; while (k < (l?.length || 0) && have.has(l[k])) k++; cur[i] += k; });
    }
  }
  // 최신 순으로 100판까지 남겨요. 못 불러온 판은 빠져서 다음에 다시 불러요.
  const all = kept().slice(0, RIOT_HISTORY);
  await redis.hset(K.riotGames, { [puuid]: { g: all, full, cur, pv: 2 } });
  const recent = ids.map(id => have.get(id)).filter(Boolean);
  const ok = recent.filter(x => RIOT_LANES.includes(x[2])), lanes = {}, champs = {}, q = [0, 0, 0];
  for (const [, c, lane, w, queue] of ok) {
    lanes[lane] = (lanes[lane] || 0) + 1;
    (champs[c] ??= [c, 0, 0])[1]++; champs[c][2] += w;
    q[queue === 420 ? 0 : queue === 440 ? 1 : 2]++;
  }
  // 라인 추천용: 모아 둔 판 전체로 라인마다 [판, 승, 많이 한 챔피언 3개 [번호, 판, 승]]
  const ls = {};
  for (const [, c, lane, w] of all) {
    if (!RIOT_LANES.includes(lane)) continue;
    const L = ls[lane] ??= [0, 0, {}];
    L[0]++; L[1] += w; (L[2][c] ??= [c, 0, 0])[1]++; L[2][c][2] += w;
  }
  for (const L of Object.values(ls)) L[2] = Object.values(L[2]).sort((a, b) => b[1] - a[1] || b[2] - a[2]).slice(0, 3);
  // n = 최근 20판 중 센 판 수, lanes = 라인별 판 수, most = 많이 한 챔피언 3개 [번호, 판, 승], q = [솔랭, 자랭, 일반] 판 수
  // hn = 모아 둔 판 수(라인 추천 기준), ls = 라인별 기록, hFull = 더 모을 판이 없음(100판이거나 예전 판이 끝남)
  const hFull = full || all.length >= RIOT_HISTORY;
  return { n: ok.length, lanes, most: Object.values(champs).sort((a, b) => b[1] - a[1] || b[2] - a[2]).slice(0, 3), q,
    hn: all.filter(x => RIOT_LANES.includes(x[2])).length, ls, hFull, hv: 2, done: recent.length === ids.length };
}
// 계정을 못 찾으면 null. PUUID는 API 키(앱)마다 달라서, 키를 바꾸면 예전 PUUID가 400으로 거절돼요. 그땐 Riot ID로 다시 찾아요.
// 돌려주는 모양: { id, puuid, solo, at(티어 시각), mast, n, lanes, most, q, gAt(최근 판까지 다 불러온 시각) }
async function riotLookup(e, ctx) {
  let acc = e.puuid ? e : await riotAccount(e.id, ctx);
  if (!acc) return null;
  let solo;
  try { solo = await riotSolo(acc.puuid, ctx); } catch (err) {
    if (err.status !== 400 || !e.puuid) throw err;
    if (!(acc = await riotAccount(e.id, ctx))) return null;
    solo = await riotSolo(acc.puuid, ctx);
  }
  const out = { ...e, id: acc.id, puuid: acc.puuid, solo, at: Date.now() };
  const mast = await soft(ctx, riotMastery(acc.puuid, ctx));
  if (mast) out.mast = mast;
  const games = await soft(ctx, riotGames(acc.puuid, ctx));
  if (games) { const { done, ...stats } = games; Object.assign(out, stats); if (done && mast) out.gAt = Date.now(); }
  return out;
}
// 100판을 다 모으기 전(hFull === false)이면 곧바로 다시 부를 차례예요. 그래서 화면이 열려 있는 동안 계속 거슬러 올라가요.
// hv = 모으는 방식 버전. v1.4.0(hv 없음)에선 잘못 "다 모음"으로 끝난 사람이 있어서, hv가 2가 아니면 다시 모아요.
const riotStaleAt = e => (e.puuid && (!e.hFull || e.hv !== 2) ? 0 : Math.min(e.at || 0, e.gAt || 0));
// "Hide on bush #KR1" → "Hide on bush#KR1". 태그 없이 이름만 넣으면 한국 계정에 가장 흔한 #KR1을 붙여요.
// (Riot API엔 이름 검색이 없어서 이름#태그가 정확해야 찾을 수 있어요)
const RIOT_DEFAULT_TAG = 'KR1';
const cleanRiotId = v => {
  const m = typeof v === 'string' && v.trim().match(/^([^#]{1,16}?)\s*(?:#\s*([^\s#]{1,5}))?$/u);
  return m ? `${m[1].trim()}#${m[2] ?? RIOT_DEFAULT_TAG}` : null;
};
// 이름 → 위 riotLookup 모양. 한 사람씩 따로 저장하는 해시라서 동시에 고쳐도 서로 안 덮어써요.
async function readRiot() {
  const hash = await redis.hgetall(K.riot);
  return Object.fromEntries(Object.entries(hash || {}).map(([n, e]) => [n, typeof e === 'string' ? JSON.parse(e) : e]));
}
// 연결을 끊거나 명단에서 빼면 남겨 둔 최근 판도 지워요 (같은 계정을 쓰는 다른 이름이 있으면 둬요)
async function dropRiot(name) {
  const e = parse(await redis.hget(K.riot, name));
  await redis.hdel(K.riot, name);
  if (e?.puuid && !Object.values(await readRiot()).some(x => x.puuid === e.puuid)) await redis.hdel(K.riotGames, e.puuid);
}
// 오래된 사람부터 불러와요. { n: 새로 불러온 사람 수, more: 아직 남은 사람이 있으면 true(쉬었다가 이어서) }
async function refreshRiot(gap) {
  const now = Date.now();
  const stale = Object.entries(await readRiot()).filter(([, e]) => now - riotStaleAt(e) >= gap).sort((a, b) => riotStaleAt(a[1]) - riotStaleAt(b[1]));
  if (!stale.length) return { n: 0, more: false };
  // 여러 명이 동시에 열어도 한 번만, 많이 부른 뒤엔 쉬는 시간이 끝날 때까지 기다려요
  if (now - (Number(await redis.get(K.riotLock)) || 0) < 60e3 || now < (Number(await redis.get(K.riotRest)) || 0)) return { n: 0, more: true };
  await redis.set(K.riotLock, now);
  const done = {}, ctx = { left: RIOT_BUDGET };
  try {
    for (const [n, e] of stale) {
      // 계정을 못 찾으면(이름을 바꿨거나 키가 바뀜) 예전 정보를 두고 시각만 바꿔서 계속 다시 묻지 않게 해요.
      done[n] = (await riotLookup(e, ctx)) ?? { ...e, at: now, gAt: now, hFull: true, hv: 2 };
      if (ctx.stop) break;
    }
  } catch (err) {
    if (!(err instanceof RiotError) || !Object.keys(done).length) throw err; // 중간에 막히면 거기까지만 저장
  } finally {
    await redis.set(K.riotLock, 0);
    if (ctx.used) await redis.set(K.riotRest, Date.now() + Math.round(RIOT_REST * ctx.used / 100));
  }
  if (Object.keys(done).length) await redis.hset(K.riot, done);
  return { n: Object.keys(done).length, more: stale.some(([n]) => !(done[n]?.gAt >= now) || !done[n]?.hFull) };
}

const cleanName = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : null);
// 이미 있는 이름이면 뒤에 번호를 붙여요: '일윤의 방' → '일윤의 방 2' (16자 안으로 줄여서)
function uniqueName(base, taken) {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) { const tail = ` ${n}`, c = base.slice(0, 16 - tail.length).trimEnd() + tail; if (!taken(c)) return c; }
}
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
  return { players, matches, riot, rooms, room: roomState, ver: Number(ver) || 0, ably: ABLY_NS };
}
// 지금 보고 있다는 신호(15초마다). 멤버는 "기기id|닉네임"이고, 방장이면 방장 신호 시각도 남겨요.
async function heartbeat(room, me, nick, claimsHost) {
  const key = RK.seen(room), now = Date.now();
  await redis.zadd(key, { score: now, member: `${me}|${nick}` });
  await redis.zremrangebyscore(key, 0, now - HOST_AWAY);
  if (claimsHost) {
    const r = parse(await redis.hget(K.rooms, room));
    if (r?.hostId === me) {
      await redis.hset(K.hostSeen, { [room]: now });
      if (r.hostNick !== nick) await redis.hset(K.rooms, { [room]: { ...r, hostNick: nick } }); // 방장이 닉네임을 바꿨으면 방 탭에도
    }
  }
  const raw = await redis.zrange(key, 0, -1, { withScores: true }), seen = new Map();
  for (let i = 0; i < raw.length; i += 2) {
    const [id, ...n] = String(raw[i]).split('|'), at = Number(raw[i + 1]);
    if (now - at < VIEW_FRESH && !(seen.get(id)?.at > at)) seen.set(id, { id, nick: n.join('|'), at }); // 닉네임을 바꿨으면 최근 것
  }
  return [...seen.values()].sort((a, b) => a.at - b.at).map(({ id, nick }) => ({ id, nick }));
}

// ---------- Ably (바뀌면 신호 쏘기 · 보고 있는 사람) ----------
// ABLY_API_KEY가 있으면 기록이 바뀔 때마다 '바뀜' 신호를 쏴요. 화면들은 계속 물어보지 않고 신호가 올 때만 새로 받아 가요.
// 채널 이름 앞에 배포 환경을 붙여서, 내 컴퓨터에서 시험한 신호가 실제 사이트로 가지 않게 해요.
const ABLY_KEY = process.env.ABLY_API_KEY;
const ABLY_NS = ABLY_KEY ? `ddong-${process.env.VERCEL_ENV || 'local'}` : null;
async function ablyPublish(ver) {
  if (!ABLY_KEY) return;
  try {
    const r = await fetch(`https://rest.ably.io/channels/${encodeURIComponent(`${ABLY_NS}:all`)}/messages`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(ABLY_KEY).toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'changed', data: { ver } }),
    });
    if (!r.ok) console.error('ably publish', r.status, await r.text());
  } catch (e) { console.error('ably publish', e); } // 신호가 실패해도 저장은 끝났어요. 화면은 2분마다 직접 확인해요.
}
// 화면에 주는 Ably 토큰 요청(1시간, 끝나면 화면이 다시 받아요). 이 기기 id로만 쓸 수 있고,
// 전체 채널은 듣기만, 방 채널은 듣기·'보고 있어요' 표시만 돼요. 키 자체는 서버에만 있어요.
function ablyTokenRequest(clientId) {
  const [keyName, secret] = ABLY_KEY.split(':');
  const capability = JSON.stringify({ [`${ABLY_NS}:all`]: ['subscribe'], [`${ABLY_NS}:room:*`]: ['presence', 'subscribe'] });
  const tr = { keyName, ttl: 36e5, capability, clientId, timestamp: Date.now(), nonce: randomBytes(8).toString('hex') };
  tr.mac = createHmac('sha256', secret).update([tr.keyName, tr.ttl, tr.capability, tr.clientId, tr.timestamp, tr.nonce, ''].join('\n')).digest('base64');
  return tr;
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
    if (req.method === 'GET' && new URL(req.url, 'http://local').searchParams.get('cron') === 'riot') {
      // Vercel Cron(vercel.json)이 하루 한 번 불러요. 아무도 사이트를 안 열어도 롤 정보·라인 추천용 판을 이어서 모아요.
      // 키 제한(2분 100번) 때문에 한 번 부르고 쉬는 시간이 지나면 또 불러서, 50초 안에서 되는 만큼 모아요(무료 요금제 함수는 최대 60초).
      // CRON_SECRET 환경변수를 넣으면 Vercel이 보내는 그 비밀값이 있을 때만 돌아요.
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'cron_only' });
      if (!process.env.RIOT_API_KEY) return res.status(200).json({ ok: false, error: 'no_riot_key' });
      const start = Date.now(); let total = 0, r = { more: true };
      while (r.more && Date.now() - start < 50e3) {
        try { r = await refreshRiot(RIOT_STALE); } catch { break; }
        total += r.n;
        if (r.n) await redis.incr(K.ver);
        const wait = Math.max((Number(await redis.get(K.riotRest)) || 0) - Date.now(), 0) + 1e3;
        if (!r.more || Date.now() - start + wait > 50e3) break;
        await new Promise(ok => setTimeout(ok, wait));
      }
      return res.status(200).json({ ok: true, refreshed: total, more: r.more });
    }
    if (req.method === 'GET') {
      // Ably가 켜져 있으면 화면은 '바뀜' 신호가 올 때와 2분마다 한 번만 물어봐요. 꺼져 있으면 5초마다 물어봐요.
      // 바뀐 게 없으면 Redis 명령 1번으로 끝내서 무료 한도를 아껴요.
      // hb=1이면 '보고 있어요' 신호예요(Ably를 쓰면 방장 자리 지키기용으로 방장만 보내요).
      const q = new URL(req.url, 'http://local').searchParams, v = q.get('v'), room = cleanId(q.get('room'));
      if (q.get('ably') === 'token') {
        const me = cleanId(q.get('me'));
        return ABLY_KEY && me ? res.status(200).json(ablyTokenRequest(me)) : bad(res);
      }
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
    // 솔랭 새로고침·닉네임 정하기는 기록을 바꾸지 않아서 비밀번호 없이도 돼요.
    if (!['refreshRiot', 'claimNick'].includes(b.action) && !pinOk(req)) return res.status(401).json({ error: 'pin_required' });
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
    let id, dup = false, refreshed, more, nick, roomId = room?.id;
    switch (b.action) {
      case 'claimNick': {
        // 닉네임은 기기마다 하나예요. 다른 기기가 쓰고 있는 닉네임이면 뒤에 번호를 붙여서 돌려줘요('일윤' → '일윤 2').
        // 내가 쓰던 예전 닉네임은 놓아줘서 다른 사람이 쓸 수 있어요. 화면에 보이는 기록은 안 바뀌어서 버전은 그대로예요.
        const want = cleanName(b.nick);
        if (!me || !want) return bad(res);
        const all = Object.entries((await redis.hgetall(K.nicks)) || {}).map(([n, v]) => [n, parse(v)]), now = Date.now();
        const taken = n => all.some(([x, v]) => x === n && v.id !== me && now - v.at < NICK_KEEP);
        nick = uniqueName(want, taken);
        for (const [x, v] of all) if (v.id === me && x !== nick) await redis.hdel(K.nicks, x);
        await redis.hset(K.nicks, { [nick]: { id: me, at: now } });
        dup = true;
        break;
      }
      case 'createRoom': {
        // 새 방을 만든 사람이 방장이에요. 오래 조용했던 방은 이때 같이 지워요.
        const nick = cleanName(b.nick);
        if (!me || !nick) return bad(res);
        const all = Object.keys((await redis.hgetall(K.rooms)) || {});
        for (const old of all) if (!rooms.some(r => r.id === old)) await dropRoom(old);
        if (rooms.length >= MAX_ROOMS) return res.status(409).json({ error: 'rooms_full' });
        const now = Date.now();
        id = roomId = now.toString(36) + Math.random().toString(36).slice(2, 7);
        const name = uniqueName(cleanName(b.name) || `${nick}의 방`, n => rooms.some(r => r.name === n)); // 같은 이름 방이 있으면 번호
        await saveRoom({ id, name, hostId: me, hostNick: nick, createdAt: now, lastActive: now });
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
        await dropRiot(name);
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
        // 명단의 한 사람에 Riot ID를 연결하고 솔랭 티어·숙련도·최근 판을 바로 불러와요. riotId를 비우면 연결을 끊어요.
        const name = cleanName(b.name);
        if (!name || !(await readPlayers()).includes(name)) return bad(res);
        if (!String(b.riotId ?? '').trim()) { await dropRiot(name); break; }
        const riotId = cleanRiotId(b.riotId);
        if (!riotId) return res.status(424).json({ error: 'bad_riot_id' });
        if (!process.env.RIOT_API_KEY) return res.status(424).json({ error: 'no_riot_key' });
        // 티어는 꼭 불러오고, 최근 판을 다 못 부르면 나머지는 새로고침이 이어서 불러요.
        const ctx = { left: RIOT_LINK_BUDGET };
        let e;
        try { e = await riotLookup({ id: riotId }, ctx); } finally {
          if (ctx.used) await redis.set(K.riotRest, Date.now() + Math.round(RIOT_REST * ctx.used / 100));
        }
        if (!e) return res.status(424).json({ error: String(b.riotId).includes('#') ? 'riot_not_found' : 'riot_not_found_kr1' });
        if (parse(await redis.hget(K.riot, name))?.puuid !== e.puuid) await dropRiot(name); // 다른 계정으로 바꿨으면 예전 판은 지워요
        await redis.hset(K.riot, { [name]: e });
        more = !e.gAt;
        break;
      }
      case 'refreshRiot': {
        // 화면이 열릴 때 6시간 넘은 사람이 있으면 부르고, 새로고침 버튼은 10분 지난 것만 다시 불러요.
        if (!process.env.RIOT_API_KEY) return res.status(424).json({ error: 'no_riot_key' });
        ({ n: refreshed, more } = await refreshRiot(b.force ? RIOT_FORCE_GAP : RIOT_STALE));
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
        // room: 어느 방에서 한 판인지 남겨서, 화면의 '이 방 기록'은 그 방 판들만 따로 세요.
        await redis.hset(K.matches, { [id]: { t: now, blue, red, win: m.win, room: room.id, ...(round && { round }) } });
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
    // 바뀌었으면 버전을 올리고 Ably로 '바뀜' 신호를 쏴요(새 상태를 읽는 동안 같이).
    const newVer = dup ? null : await redis.incr(K.ver);
    const [state] = await Promise.all([readState(roomId), newVer != null && ablyPublish(newVer)]);
    return res.status(200).json({ id, dup, refreshed, more, nick, ...state });
  } catch (e) {
    if (e instanceof RiotError) return res.status(424).json({ error: e.code });
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
