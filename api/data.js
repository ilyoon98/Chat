import { Redis } from '@upstash/redis';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

// Vercel Marketplace의 Upstash Redis를 연결하면 아래 환경변수가 자동으로 들어와요.
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = globalThis.__redis ?? (url && token ? new Redis({ url, token }) : null);

const K = { players: 'lol:players', matches: 'lol:matches', ver: 'lol:ver', riot: 'lol:riot', riotLock: 'lol:riot:lock', riotRest: 'lol:riot:rest', riotGames: 'lol:riot:games', rooms: 'lol:rooms', hostSeen: 'lol:hostseen', nicks: 'lol:nicks', duels: 'lol:duels', mvp: 'lol:mvp', seasons: 'lol:seasons', pred: 'lol:pred', tourn: 'lol:tourn', gone: 'lol:gone', mvpLock: 'lol:mvp:lock', games: 'lol:games' };
// 방마다 따로인 것: 오늘 할 사람(정렬 집합), 팀 배치, 지금 보고 있는 사람(정렬 집합, 점수 = 마지막 신호 시각)
const RK = { sel: r => `lol:room:${r}:sel`, cur: r => `lol:room:${r}:cur`, seen: r => `lol:room:${r}:seen`, board: (r, s) => `lol:room:${r}:board:${s}`, bver: r => `lol:room:${r}:bver`, pick: r => `lol:room:${r}:pick` /* 예전 '뭐 하지' 방 결과. 이제 안 쓰지만 방을 닫을 때 남은 걸 지워요 */, meal: r => `lol:room:${r}:meal` };
// 인게임 타이머 보드: 방마다 블루팀·레드팀·솔랭(우리끼리) 셋. 해시 필드 'start'(게임 0초 시각), 'r:라인'({ s: [스펠 둘], b: 신발, c: 우주적 통찰력 }),
// 'e:라인:칸'(그 스펠이 돌아오는 시각, 0이면 준비). 바뀌면 그 방 보드 버전(bver)만 올려요.
// (오브젝트 타이머 'o:…'는 v1.22.1에서 뺐어요. 게임 안에서도 보여서요. 예전 보드에 남은 값은 화면이 안 읽어요.)
const BOARD_SIDES = ['blue', 'red', 'solo'], BOARD_LANES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const BOARD_SPELLS = ['flash', 'tp', 'ignite', 'exhaust', 'cleanse', 'heal', 'barrier', 'ghost', 'smite'];
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
// 내전 라인: { 이름: 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' } 중 그 판에 뛴 사람 것만. 없으면 undefined(라인 안 정한 판).
const cleanLanes = (o, names) => {
  const out = Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([n, L]) => names.includes(n) && RIOT_LANES.includes(L)));
  return Object.keys(out).length ? out : undefined;
};
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
  await redis.del(RK.sel(id), RK.cur(id), RK.seen(id), RK.bver(id), RK.pick(id), RK.meal(id), ...BOARD_SIDES.map(s => RK.board(id, s)));
}
// 1:1 기록: { id, t, a, b(두 사람), w(이긴 사람 이름), rule('자유'·'퍼블'·'100CS'·'첫 타워') }. 내전 기록과 따로예요.
const DUEL_RULES = ['자유', '퍼블', '100CS', '첫 타워'];
async function readDuels() {
  const hash = await redis.hgetall(K.duels);
  return Object.entries(hash || {}).map(([id, d]) => ({ id, ...parse(d) })).sort((a, b) => a.t - b.t);
}
// MVP 투표: 해시 필드 '판id|기기id' → { n: 뽑은 이름, t }. 기기마다 한 판에 한 표(다시 고르면 바뀌어요).
// 화면에는 판마다 { 이름: 표 수 }만 줘요. 누가 누구를 뽑았는지는 안 보여요.
const MVP_OPEN = 24 * 36e5; // 기록하고 하루 안에만 투표할 수 있어요
// 투표가 끝난 판의 표는 판 기록 안 'mvp'({ 이름: 표 수 })로 옮겨 둬요(compactMvp). 화면에 줄 땐 둘을 더해요.
function mergeMvp(matches, votes) {
  const out = {};
  for (const m of matches) if (m.mvp && typeof m.mvp === 'object') out[m.id] = { ...m.mvp };
  for (const [k, v] of Object.entries(votes || {})) {
    const mid = k.split('|')[0], n = parse(v)?.n;
    if (typeof n === 'string') (out[mid] ??= {})[n] = (out[mid][n] || 0) + 1;
  }
  return out;
}
// 투표가 끝난 판(기록하고 24시간 지남)의 표를 판 기록 'mvp'로 합치고 표 해시에서 지워요. 판이 없어진 표도 치워요.
// 상태를 읽을 때마다 표 해시를 통째로 읽어서, 이렇게 안 하면 판이 쌓일수록 계속 커져요. 판을 기록할 때와 매일 새벽 Cron에서 불러요.
// 두 곳에서 동시에 돌면 표를 두 번 셀 수 있어서, 1분짜리 잠금을 걸어요.
async function compactMvp(matches) {
  const votes = (await redis.hgetall(K.mvp)) || {}, now = Date.now(), byId = new Map(matches.map(m => [m.id, m]));
  const stale = Object.keys(votes).filter(k => { const m = byId.get(k.split('|')[0]); return !m || now - m.t > MVP_OPEN; });
  if (!stale.length || now - (Number(await redis.get(K.mvpLock)) || 0) < 60e3) return;
  await redis.set(K.mvpLock, now);
  try {
    const changed = {};
    for (const k of stale) {
      const mid = k.split('|')[0], m = byId.get(mid), n = parse(votes[k])?.n;
      if (!m || typeof n !== 'string' || ![...m.blue, ...m.red].includes(n)) continue;
      const { id, ...rest } = changed[mid] ? { id: mid, ...changed[mid] } : m;
      changed[mid] = { ...rest, mvp: { ...rest.mvp, [n]: (rest.mvp?.[n] || 0) + 1 } };
    }
    if (Object.keys(changed).length) await redis.hset(K.matches, changed);
    await redis.hdel(K.mvp, ...stale);
  } finally { await redis.set(K.mvpLock, 0); }
}
// 백업에 들어 있던 판 기록의 MVP 표 수: 그 판에 뛴 사람만, 1~100표
const cleanMvpCounts = (o, names) => {
  const out = Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([n, k]) => names.includes(n) && Number.isInteger(k) && k > 0 && k <= 100));
  return Object.keys(out).length ? out : undefined;
};
async function dropMvp(mid) {
  const keys = Object.keys((await redis.hgetall(K.mvp)) || {}).filter(k => k.startsWith(mid + '|'));
  if (keys.length) await redis.hdel(K.mvp, ...keys); // 한 번에 지워요
}
// ---------- 오늘 뭐 하지? 룰렛 ----------
// 게임 목록(lol:games)은 모두 같이 써요(닉네임을 정한 사람 누구나 고쳐요). 한 번도 안 고쳤으면 null이고 화면이 기본 목록을 보여줘요.
// 방에서 돌리면 서버가 하나를 뽑아 그 방 'pick'에 남겨요: { t, cands(돌린 후보), i(뽑힌 번호), game, by(돌린 사람), hist(최근 결과 5개) }.
// 구경하는 화면도 같은 후보·같은 결과로 돌림판이 돌아가요.
const MAX_GAMES = 30;
const cleanGames = (a, max = MAX_GAMES) => (Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 20)).filter(Boolean))].slice(0, max) : null);
// 이 기기가 정해 둔 닉네임(30일 안에 쓴 것). 없으면 null이에요.
// MVP 투표·승부 예측은 닉네임을 정한 기기만 받아요. 기기 id만 바꿔서 표를 여러 번 던지기 어렵게 하는 가벼운 장치예요.
async function nickOf(me) {
  if (!me) return null;
  const now = Date.now();
  for (const [n, v] of Object.entries((await redis.hgetall(K.nicks)) || {})) { const x = parse(v); if (x?.id === me && now - x.at < NICK_KEEP) return n; }
  return null;
}
const needNick = res => res.status(409).json({ error: 'need_nick' });
// 일부러 지운 판·1:1·토너먼트 id를 남겨 둬요(id → 지운 시각). 백업을 불러와도 이건 다시 넣지 않아요.
// 전체 초기화는 "백업 받고 초기화"라서 남기지 않아요. 그래야 그 백업으로 다 되살릴 수 있어요.
const markGone = ids => (ids.length ? redis.hset(K.gone, Object.fromEntries(ids.map(x => [x, Date.now()]))) : null);
// 진 팀 벌칙 룰렛 결과: 방 팀 배치(current)에 같이 저장해서 구경하는 화면에도 같은 결과가 돌아가요.
const PEN_ALL = '진 팀 전체';
const cleanPenalty = (p, losers) => (p && typeof p === 'object' && typeof p.what === 'string' && p.what.trim() && (losers.includes(p.who) || p.who === PEN_ALL)
  ? { who: p.who, what: p.what.trim().slice(0, 40), t: Number(p.t) || Date.now(), round: Number(p.round) || 0 } : undefined);
// 시즌: 시즌 2부터 시작한 시각(ms)을 순서대로 남겨요. 시작 전 기록은 모두 시즌 1이에요.
// 판은 지우거나 고치지 않고, 화면이 판 시각으로 시즌을 나눠서 MMR·티어·전적을 새로 세요.
const readSeasons = async () => ((await redis.get(K.seasons)) || []).map(Number).filter(t => t > 0).sort((a, b) => a - b);
// ---------- 토너먼트 ----------
// 해시 'id' → { name, game, ents: [[이름…], …](참가하는 사람·팀), rounds: [[{ a, b, w }]], champ, t, doneAt }
// a·b는 ents 번호, w는 이긴 쪽('a'|'b'). 1라운드는 위쪽 절반이 각 판의 a, 나머지가 앞 판부터 b에 들어가고, 빈자리는 부전승이에요.
// 이긴 쪽은 다음 라운드 '판 번호/2' 판으로 올라가요(짝수 판이면 a, 홀수 판이면 b 자리). 마지막 판 승자가 우승(champ)이에요.
const MAX_TOURN = 50;
async function readTourns() {
  return Object.entries((await redis.hgetall(K.tourn)) || {}).map(([id, v]) => ({ id, ...parse(v) })).filter(x => Array.isArray(x.rounds) && Array.isArray(x.ents)).sort((a, b) => b.t - a.t);
}
function tournAdvance(T, r, i) {
  const m = T.rounds[r][i], win = m.w ? m[m.w] : null;
  if (r + 1 < T.rounds.length) T.rounds[r + 1][i >> 1][i % 2 ? 'b' : 'a'] = win;
  else { T.champ = win; T.doneAt = win == null ? null : Date.now(); }
}
function makeTourn(name, game, ents) {
  const n = ents.length, P = 2 ** Math.ceil(Math.log2(n)), half = P / 2, rounds = [];
  rounds.push(Array.from({ length: half }, (_, i) => ({ a: i, b: i < n - half ? half + i : null, w: null })));
  for (let k = half / 2; k >= 1; k /= 2) rounds.push(Array.from({ length: k }, () => ({ a: null, b: null, w: null })));
  const T = { name, game, ents, rounds, champ: null, t: Date.now(), doneAt: null };
  rounds[0].forEach((m, i) => { if (m.b == null) { m.w = 'a'; tournAdvance(T, 0, i); } }); // 부전승은 바로 올라가요
  return T;
}
// 승부 예측: 해시 필드 '판round|기기id' → { s: 'blue'|'red', n: 닉네임, t }. 화면에는 기기id 대신 짧은 열쇠(k)만 줘요.
const predKey = id => createHash('sha256').update(id).digest('hex').slice(0, 10);
// 판을 지우거나 되돌리면 그 판(round)의 예측도 지워요(결과를 보고 다시 찍지 못하게).
async function dropPredRounds(rounds) {
  const rs = new Set(rounds.filter(Boolean).map(String)); if (!rs.size) return;
  const keys = Object.keys((await redis.hgetall(K.pred)) || {}).filter(f => rs.has(f.split('|')[0]));
  if (keys.length) await redis.hdel(K.pred, ...keys);
}
async function readPred() {
  return Object.entries((await redis.hgetall(K.pred)) || {}).map(([f, v]) => {
    const [r, id] = f.split('|'), x = parse(v);
    return x && ['blue', 'red'].includes(x.s) ? { r: Number(r), k: predKey(id), n: String(x.n || ''), s: x.s, t: Number(x.t) || 0 } : null;
  }).filter(Boolean);
}
async function readState(room) {
  // 방 정보(오늘 할 사람·팀 배치·타이머 보드)도 다른 기록과 한 번에 같이 읽어요(DB에 한 번만 다녀와요). 없는 방이면 버려요.
  const roomPart = room ? Promise.all([readSelected(room), redis.get(RK.cur(room)), redis.get(RK.bver(room)), redis.get(RK.meal(room)), ...BOARD_SIDES.map(s => redis.hgetall(RK.board(room, s)))]) : null;
  const [players, matches, ver, riot, rooms, duels, votes, seasons, pred, tourns, games, rp] = await Promise.all([readPlayers(), readMatches(), redis.get(K.ver), readRiot(), readRooms(), readDuels(), redis.hgetall(K.mvp), readSeasons(), readPred(), readTourns(), redis.get(K.games), roomPart]);
  const mvp = mergeMvp(matches, votes);
  const r = rooms.find(x => x.id === room);
  const roomState = r && rp ? { id: r.id, selected: rp[0], current: rp[1] || null, bver: Number(rp[2]) || 0, meal: rp[3] || null, boards: Object.fromEntries(BOARD_SIDES.map((s, i) => [s, rp[4 + i] || {}])) } : null;
  return { players, matches, duels, mvp, pred, tourns, riot, rooms, seasons, games: Array.isArray(games) ? games : null, room: roomState, ver: Number(ver) || 0, ably: ABLY_NS, now: Date.now() };
}
// 지금 보고 있다는 신호(15초마다). 멤버는 "기기id|닉네임"이고, 방장이면 방장 신호 시각도 남겨요.
async function heartbeat(room, me, nick, claimsHost) {
  // DB에 두 번만 다녀와요: ① 내 신호 남기기·오래된 신호 치우기·방 읽기를 같이, ② 방장 신호·지금 보는 사람 목록을 같이.
  const key = RK.seen(room), now = Date.now();
  const [, , rawRoom] = await Promise.all([
    redis.zadd(key, { score: now, member: `${me}|${nick}` }),
    redis.zremrangebyscore(key, 0, now - HOST_AWAY), // 방금 넣은 내 신호(now)는 안 지워져요
    claimsHost ? redis.hget(K.rooms, room) : null,
  ]);
  const r = parse(rawRoom), host = claimsHost && r?.hostId === me;
  const [raw] = await Promise.all([
    redis.zrange(key, 0, -1, { withScores: true }),
    host && redis.hset(K.hostSeen, { [room]: now }),
    host && r.hostNick !== nick && redis.hset(K.rooms, { [room]: { ...r, hostNick: nick } }), // 방장이 닉네임을 바꿨으면 방 탭에도
  ]);
  const seen = new Map();
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
async function ablyPublish(ver, extra) {
  if (!ABLY_KEY) return;
  try {
    const r = await fetch(`https://rest.ably.io/channels/${encodeURIComponent(`${ABLY_NS}:all`)}/messages`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(ABLY_KEY).toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'changed', data: { ver, ...extra } }), // 타이머는 { room, bv }: 그 방 화면만 다시 받아요
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

// ---------- 디스코드 알림 ----------
// DISCORD_WEBHOOK_URL 환경변수에 디스코드 채널 웹후크 주소를 넣으면, 내전·1:1 결과와 벌칙 당첨을 그 채널에 올려요. 안 넣으면 아무것도 안 해요.
const DISCORD = process.env.DISCORD_WEBHOOK_URL;
const LANE_KO = { TOP: '탑', JUNGLE: '정글', MIDDLE: '미드', BOTTOM: '원딜', UTILITY: '서폿' };
const TEAM_KO = { blue: '1팀 블루', red: '2팀 레드' };
async function discord(content) {
  if (!DISCORD) return;
  try {
    // allowed_mentions를 비워서 이름에 @everyone 같은 게 있어도 아무도 안 불려요
    // 4초 안에 답이 없으면 포기해요. 디스코드가 느려도 기록 저장 답은 바로 가요.
    const r = await fetch(DISCORD, { method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }) });
    if (!r.ok) console.error('discord', r.status, await r.text());
  } catch (e) { console.error('discord', e); } // 알림이 실패해도 기록은 저장됐어요
}
function matchText(m, roomName) {
  const order = p => (m.lanes?.[p] ? Object.keys(LANE_KO).indexOf(m.lanes[p]) : 9);
  const team = side => [...m[side]].sort((a, b) => order(a) - order(b)).map(p => (m.lanes?.[p] ? `${LANE_KO[m.lanes[p]]} ${p}` : p)).join(', ');
  return `🏆 **${TEAM_KO[m.win]} 승리**${roomName ? ` · ${roomName}` : ''}\n🔵 ${TEAM_KO.blue}: ${team('blue')}\n🔴 ${TEAM_KO.red}: ${team('red')}`;
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
      await compactMvp(await readMatches()); // 투표가 끝난 MVP 표도 판 기록으로 합쳐 둬요
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
        // bv: 그 방 타이머 보드 버전. 타이머는 전체 버전(ver)을 안 올려서, 다른 방 화면은 다시 안 받아요.
        const bvq = q.get('bv');
        const [ver, bv] = await Promise.all([redis.get(K.ver), room && bvq !== null ? redis.get(RK.bver(room)) : null]);
        if (String(Number(ver) || 0) === v && (bvq === null || !room || String(Number(bv) || 0) === bvq)) return res.status(200).json({ same: true, ver: Number(ver) || 0, presence });
      }
      return res.status(200).json({ ...(await readState(room)), presence });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    // 솔랭 새로고침·닉네임 정하기는 기록을 바꾸지 않아서 비밀번호 없이도 돼요. MVP 투표도 구경하는 사람 누구나 해요.
    // 승부 예측·인게임 타이머도 구경하는 친구 누구나 해요(참가 신청은 비밀번호를 걸었으면 비밀번호가 필요해요).
    if (!['refreshRiot', 'claimNick', 'voteMvp', 'predict', 'board', 'spinMeal'].includes(b.action) && !pinOk(req)) return res.status(401).json({ error: 'pin_required' });
    // 방장 확인: 기기마다 화면이 만든 id(x-device)로 구분해요. 친구끼리 쓰는 거라 로그인 없이 이 정도로 막아요.
    const me = cleanId(req.headers['x-device']), rooms = await readRooms();
    const room = rooms.find(r => r.id === cleanId(b.room)), isHost = r => !!r && !!me && r.hostId === me;
    const notHost = () => res.status(423).json({ error: 'not_host' });
    // 선수 명단(추가·이름 바꾸기·빼기·Riot ID)은 누구나 고쳐요. 내전 기록 삭제·백업 불러오기·새 시즌·초기화는
    // 모든 방이 같이 쓰는 기록이라 어느 방이든 방장인 사람만 해요.
    // 전체 초기화·백업 불러오기·새 시즌은 어느 방이든 방장만. 기록 한 판·여러 판 지우기는 방이 다 닫혀도 지울 수 있게 닉네임을 정한 사람 누구나(아래).
    const rosterAction = ['resetRecords', 'importBackup', 'startSeason'].includes(b.action);
    if (['deleteMatch', 'deleteMatches'].includes(b.action) && !(await nickOf(me))) return needNick(res);
    if (rosterAction && !rooms.some(isHost)) return notHost();
    // 그 방의 오늘 할 사람·팀 배치·승패, 1:1 기록, 토너먼트 만들기·결과·지우기는 지금 들어가 있는 그 방 방장만(같이 하기는 방에서 해요)
    if (['select', 'current', 'addMatch', 'giveHost', 'closeRoom', 'addDuel', 'createTourn', 'tournWin', 'deleteTourn'].includes(b.action)) {
      if (!room) return res.status(404).json({ error: 'no_room' });
      if (!isHost(room)) return notHost();
    }
    let id, dup = false, refreshed, more, nick, roomId = room?.id, notify, imported, bv = null;
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
      case 'removePlayers': {
        // 여러 명을 한 번에 명단에서 빼요(선수 명단 '여러 명 고르기', 누구나). 지난 전적은 그대로 남아요.
        const names = cleanNames(b.names, MAX_PLAYERS);
        if (!names?.length) return bad(res);
        await redis.set(K.players, (await readPlayers()).filter(p => !names.includes(p)));
        for (const r of rooms) await redis.zrem(RK.sel(r.id), ...names);
        for (const n of names) await dropRiot(n);
        break;
      }
      case 'deleteMatches': {
        // 여러 판을 한 번에 지워요(기록 탭 '여러 판 고르기', 닉네임을 정한 사람 누구나). 그 판들의 MVP 표도 같이 지워요.
        const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter(x => typeof x === 'string' && x))].slice(0, MAX_MATCHES) : [];
        if (!ids.length) return bad(res);
        const gone = new Set(ids), rounds = (await readMatches()).filter(m => gone.has(m.id)).map(m => m.round);
        await redis.hdel(K.matches, ...ids);
        await markGone(ids);
        const votes = Object.keys((await redis.hgetall(K.mvp)) || {}).filter(k => gone.has(k.split('|')[0]));
        if (votes.length) await redis.hdel(K.mvp, ...votes);
        await dropPredRounds(rounds); // 그 판 승부 예측도 지워요
        break;
      }
      case 'resetRecords': {
        // 전체 기록 초기화(방장): 내전·1:1·MVP 표·시즌을 모두 지워요. 선수 명단·Riot ID·방·팀 배치는 그대로예요.
        // 화면이 지우기 전에 백업 파일을 먼저 받아 두고, 실수로 불리지 않게 '초기화'라는 글자를 같이 보내야 해요.
        if (b.confirm !== '초기화') return bad(res);
        await redis.del(K.matches, K.duels, K.mvp, K.seasons, K.pred, K.tourn);
        for (const r of rooms) { const cur = await redis.get(RK.cur(r.id)); if (cur?.penalty) { const { penalty, ...rest } = cur; await redis.set(RK.cur(r.id), rest); } }
        break;
      }
      case 'createTourn': {
        // 새 토너먼트(그 방 방장): 참가자(사람 또는 팀) 2~32. 순서대로 대진표 칸에 들어가요(화면이 미리 섞어서 보내요).
        const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 30) : null, game = typeof b.game === 'string' ? b.game.trim().slice(0, 20) : '';
        const ents = Array.isArray(b.entrants) ? b.entrants.map(e => cleanNames(e, 5)).filter(e => e?.length) : [], all = ents.flat();
        if (!name || ents.length < 2 || ents.length > 32 || new Set(all).size !== all.length) return bad(res);
        if ((await readTourns()).length >= MAX_TOURN) return res.status(409).json({ error: 'tourn_full' });
        id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await redis.hset(K.tourn, { [id]: { ...makeTourn(name, game, ents), byNick: room.hostNick } }); // byNick: 만든 방장 닉네임
        break;
      }
      case 'tournWin': {
        // 대진표 한 판의 승자(방장). 같은 쪽을 다시 누르면 풀어요. 다음 라운드 판 결과가 이미 있으면 그걸 먼저 풀어야 바꿀 수 있어요.
        const tid = typeof b.id === 'string' ? b.id : '', T = tid && parse(await redis.hget(K.tourn, tid));
        const r = Number(b.r), i = Number(b.i), w = b.w === 'a' || b.w === 'b' ? b.w : null, m = T?.rounds?.[r]?.[i];
        if (!m) return res.status(404).json({ error: 'no_tourn' });
        if (m.a == null || m.b == null) return bad(res); // 부전승이나 아직 상대가 안 정해진 판
        if (m.w === w) { dup = true; break; }
        if (T.rounds[r + 1]?.[i >> 1]?.w) return res.status(409).json({ error: 'tourn_locked' });
        m.w = w; tournAdvance(T, r, i);
        await redis.hset(K.tourn, { [tid]: T });
        if (w && r === T.rounds.length - 1) notify = `🏆 **${T.name}** 우승: ${T.ents[T.champ].join('·')}${T.game ? ` (${T.game})` : ''}`;
        break;
      }
      case 'deleteTourn': {
        if (typeof b.id !== 'string' || !b.id) return bad(res);
        await redis.hdel(K.tourn, b.id);
        await markGone([b.id]);
        break;
      }
      case 'board': {
        // 인게임 타이머(누구나): 게임하면서 상대 스펠 시간을 같은 보드를 연 친구들과 같이 봐요.
        // 끝나는 시각은 서버 시계로 정해요(폰마다 시계가 조금씩 달라도 같게 보이게). dur은 초.
        if (!room) return res.status(404).json({ error: 'no_room' });
        const side = BOARD_SIDES.includes(b.side) ? b.side : null, now = Date.now(), dur = b.dur == null ? null : Number(b.dur);
        if (!side || (dur != null && !(dur > 0 && dur <= 900))) return bad(res);
        const key = RK.board(room.id, side);
        if (b.op === 'reset') await redis.del(key);
        else if (b.op === 'start') {
          const off = b.offset == null ? null : Number(b.offset);
          if (off == null) await redis.hdel(key, 'start');
          else if (off >= 0 && off <= 7200) await redis.hset(key, { start: now - off * 1000 });
          else return bad(res);
        } else if (b.op === 'row') {
          // 라인 설정(스펠 둘·신발·통찰)은 'r:라인', 스펠 칸마다 끝나는 시각은 'e:라인:칸' 따로 둬서 같은 라인을 동시에 눌러도 안 지워져요
          if (!BOARD_LANES.includes(b.lane) || !(Array.isArray(b.s) && b.s.length === 2 && b.s.every(x => BOARD_SPELLS.includes(x)))) return bad(res);
          await redis.hset(key, { ['r:' + b.lane]: { s: b.s, b: !!b.b, c: !!b.c } });
        } else if (b.op === 'spell') {
          const k = Number(b.slot);
          if (!BOARD_LANES.includes(b.lane) || (k !== 0 && k !== 1)) return bad(res);
          await redis.hset(key, { [`e:${b.lane}:${k}`]: dur == null ? 0 : now + dur * 1000 });
        } else return bad(res);
        bv = await redis.incr(RK.bver(room.id)); dup = true; // 전체 버전은 그대로, 이 방 보드 버전만 올려요
        break;
      }
      case 'setGames': {
        // 게임 목록 고치기(닉네임을 정한 사람 누구나): 목록을 통째로 보내요. 비우면 기본 목록으로 돌아가요.
        const games = cleanGames(b.games);
        if (!games) return bad(res);
        if (!(await nickOf(me))) return needNick(res);
        if (games.length) await redis.set(K.games, games); else await redis.del(K.games);
        break;
      }
      case 'spinMeal': {
        // 밥 뭐 먹지(닉네임을 정한 사람 누구나, 그 방에서): 슬롯 세 칸(종류·나라·맵기)과 그 조건의 메뉴 후보는 화면이 정해 보내고,
        // 마지막 메뉴는 서버가 뽑아요. 그 방 'meal'에 남겨서 구경하는 화면도 같은 슬롯·같은 공 길(시각 t로 정해요)로 같이 돌아요.
        if (!room) return res.status(404).json({ error: 'no_room' });
        const nk = await nickOf(me);
        if (!nk) return needNick(res);
        const reels = cleanGames(b.reels, 3), cands = cleanGames(b.cands, 8);
        if (!reels || reels.length !== 3 || !cands || cands.length < 2) return bad(res);
        const prev = await redis.get(RK.meal(room.id)), i = randomInt(cands.length), t = Date.now();
        const hist = [{ menu: cands[i], t, by: nk }, ...(Array.isArray(prev?.hist) ? prev.hist : [])].slice(0, 5);
        await redis.set(RK.meal(room.id), { t, reels, cands, i, menu: cands[i], by: nk, hist });
        await saveRoom({ ...room, lastActive: t });
        notify = `🍚 밥 뭐 먹지? → **${cands[i]}** (${reels.join(' · ')} · ${nk}님이 돌렸어요)`;
        bv = await redis.incr(RK.bver(room.id)); dup = true;
        break;
      }
      case 'selfSelect': {
        // 참가 신청(누구나): 명단에 있는 이름 하나를 그 방 오늘 할 사람에 넣거나 빼요. 방장이 아니어도 돼요.
        const name = cleanName(b.name);
        if (!room) return res.status(404).json({ error: 'no_room' });
        if (!name || !(await readPlayers()).includes(name)) return bad(res);
        if (b.on === false) await redis.zrem(RK.sel(room.id), name);
        else await redis.zadd(RK.sel(room.id), { nx: true }, { score: Date.now(), member: name });
        await saveRoom({ ...room, lastActive: Date.now() });
        bv = await redis.incr(RK.bver(room.id)); dup = true; // 그 방 화면만 다시 받아요(타이머처럼)
        break;
      }
      case 'predict': {
        // 승부 예측(누구나): 지금 그 방 팀 배치의 판(round)에만, 결과를 기록하기 전까지 한 표. side를 비우면 내 예측을 거둬요.
        // 이름은 화면이 보낸 게 아니라 이 기기가 정해 둔 닉네임으로 남겨요(예측왕에 다른 사람 이름으로 찍지 못하게).
        const round = Number(b.round), side = b.side == null || b.side === '' ? null : b.side;
        if (!me || !round || (side && !['blue', 'red'].includes(side))) return bad(res);
        if (!room) return res.status(404).json({ error: 'no_room' });
        const nk = await nickOf(me);
        if (!nk) return needNick(res);
        const cur = await redis.get(RK.cur(room.id));
        if (!cur?.blue?.length || !cur?.red?.length || Number(cur.round ?? cur.t) !== round) return res.status(409).json({ error: 'pred_stale' });
        const matches = await readMatches();
        if (matches.some(m => m.round === round)) return res.status(409).json({ error: 'pred_closed' });
        const field = `${round}|${me}`, prev = parse(await redis.hget(K.pred, field))?.s ?? null;
        if (prev === side) { dup = true; break; }
        if (side) await redis.hset(K.pred, { [field]: { s: side, n: nk, t: Date.now() } }); else await redis.hdel(K.pred, field);
        // 결과가 안 나온 채 사흘 지난 예측(다시 섞어서 버려진 판)은 치워요
        const done = new Set(matches.map(m => m.round));
        const old = Object.entries((await redis.hgetall(K.pred)) || {}).filter(([f, v]) => !done.has(Number(f.split('|')[0])) && Date.now() - (parse(v)?.t || 0) > 3 * 864e5).map(([f]) => f);
        if (old.length) await redis.hdel(K.pred, ...old);
        bv = await redis.incr(RK.bver(room.id)); dup = true; // 예측은 그 방에서만 보여서 그 방 화면만 다시 받아요
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
        const swapGame = g => ({ ...g, blue: swap(g.blue), red: swap(g.red), ...(g.lanes && { lanes: Object.fromEntries(Object.entries(g.lanes).map(([n, L]) => [n === from ? to : n, L])) }), ...(g.penalty?.who === from && { penalty: { ...g.penalty, who: to } }), ...(g.bench && { bench: swap(g.bench) }), ...(g.mvp && { mvp: Object.fromEntries(Object.entries(g.mvp).map(([n, k]) => [n === from ? to : n, k])) }) });
        const both = g => [...g.blue, ...g.red].includes(from) && [...g.blue, ...g.red].includes(to);
        const [matches, curs] = await Promise.all([readMatches(), Promise.all(rooms.map(r => redis.get(RK.cur(r.id))))]);
        // 같은 판에 둘 다 뛴 적이 있거나 어느 방 팀에 둘 다 있으면 서로 다른 사람이라 합칠 수 없어요.
        const dueled = (await readDuels()).some(d => [d.a, d.b].includes(from) && [d.a, d.b].includes(to)); // 1:1로 서로 붙은 사이도 다른 사람
        const tourns = await readTourns(), inTourn = tourns.some(t => { const all = t.ents.flat(); return all.includes(from) && all.includes(to); }); // 같은 토너먼트에 둘 다 나왔어도
        if (matches.some(both) || curs.some(c => c?.blue && c?.red && both(c)) || dueled || inTourn) {
          return res.status(422).json({ error: 'played_together' });
        }
        const players = await readPlayers();
        await redis.set(K.players, players.includes(to) ? players.filter(p => p !== from) : players.map(p => (p === from ? to : p)));
        const changed = {};
        for (const { id: mid, ...m } of matches) {
          if (m.blue.includes(from) || m.red.includes(from)) changed[mid] = swapGame(m);
        }
        if (Object.keys(changed).length) await redis.hset(K.matches, changed);
        // 1:1 기록도 새 이름으로 (같은 1:1에 둘 다 있으면 위에서 이미 막혀요)
        const duelsChanged = {};
        for (const { id: did, ...d } of await readDuels()) {
          if (d.a === from || d.b === from) duelsChanged[did] = { ...d, a: d.a === from ? to : d.a, b: d.b === from ? to : d.b, w: d.w === from ? to : d.w };
        }
        if (Object.keys(duelsChanged).length) await redis.hset(K.duels, duelsChanged);
        for (const [i, r] of rooms.entries()) {
          if (curs[i]?.blue && curs[i]?.red) await redis.set(RK.cur(r.id), swapGame(curs[i]));
          const score = await redis.zscore(RK.sel(r.id), from); // 오늘 할 사람에 있었으면 같은 자리에 새 이름으로
          if (score != null) { await redis.zadd(RK.sel(r.id), { nx: true }, { score: Number(score), member: to }); await redis.zrem(RK.sel(r.id), from); }
        }
        const riotIds = await readRiot(); // 연결된 Riot ID도 새 이름으로 (합칠 땐 원래 있던 쪽을 둬요)
        if (riotIds[from]) { if (!riotIds[to]) await redis.hset(K.riot, { [to]: riotIds[from] }); await redis.hdel(K.riot, from); }
        const tChanged = {}; // 토너먼트 참가자 이름도 새 이름으로
        for (const { id: tid, ...t } of tourns) if (t.ents.flat().includes(from)) tChanged[tid] = { ...t, ents: t.ents.map(e => e.map(p => (p === from ? to : p))) };
        if (Object.keys(tChanged).length) await redis.hset(K.tourn, tChanged);
        const votes = {}; // MVP 표도 새 이름으로
        for (const [k, v] of Object.entries((await redis.hgetall(K.mvp)) || {})) if (parse(v)?.n === from) votes[k] = { ...parse(v), n: to };
        if (Object.keys(votes).length) await redis.hset(K.mvp, votes);
        break;
      }
      case 'importBackup': {
        // 백업 파일(기록 탭 '백업 받기')을 다시 넣어요. 지금 기록에 없는 것만 더하고, 있는 건 지우거나 덮어쓰지 않아요.
        // 같은 판인지는 판 id, 또는 시각·팀·결과가 모두 같은지로 봐요. Riot ID는 명단에 있고 아직 연결 안 된 사람만 되살려요.
        const [players, matches, duels, riotNow, goneHash] = await Promise.all([readPlayers(), readMatches(), readDuels(), readRiot(), redis.hgetall(K.gone)]);
        const gone = new Set(Object.keys(goneHash || {})); // 일부러 지운 판·1:1·토너먼트 id
        const team = a => [...a].sort().join('\u0001');
        const mKey = m => `${m.t}|${m.win}|${team(m.blue)}|${team(m.red)}`, dKey = d => `${d.t}|${d.w}|${team([d.a, d.b])}`;
        const okId = v => (typeof v === 'string' && /^[a-z0-9]{4,40}$/.test(v) ? v : null), okKey = v => typeof v === 'string' && /^[0-9a-f]{10}$/.test(v);
        const newId = (t, pre = '') => pre + t.toString(36) + Math.random().toString(36).slice(2, 7);
        imported = { players: 0, matches: 0, duels: 0, riot: 0, gone: 0 };
        const addP = [];
        for (const n of cleanNames(b.players, MAX_PLAYERS) || []) if (!players.includes(n) && players.length + addP.length < MAX_PLAYERS) addP.push(n);
        if (addP.length) { await redis.set(K.players, [...players, ...addP]); imported.players = addP.length; }
        const seenId = new Set(matches.map(m => m.id)), seenKey = new Set(matches.map(mKey)), addM = {};
        for (const m of Array.isArray(b.matches) ? b.matches : []) {
          const blue = cleanNames(m?.blue, 10), red = cleanNames(m?.red, 10), t = Number(m?.t);
          if (!blue?.length || !red?.length || blue.some(p => red.includes(p)) || !['blue', 'red'].includes(m.win) || !(t > 0 && t <= Date.now() + 6e4)) continue; // 앞날짜 판은 빼요
          const x = { t, blue, red, win: m.win }, mid = okId(m.id) || newId(t);
          if (gone.has(mid)) { imported.gone++; continue; }
          if (seenId.has(mid) || seenKey.has(mKey(x)) || matches.length + imported.matches >= MAX_MATCHES) continue;
          const lanes = cleanLanes(m.lanes, [...blue, ...red]), round = Number(m.round) || 0, rid = cleanId(m.room);
          const pen = cleanPenalty(m.penalty, m.win === 'blue' ? red : blue); // 백업에 있던 벌칙도 같이
          const mvp = cleanMvpCounts(m.mvp, [...blue, ...red]); // 투표가 끝나서 판 기록에 합쳐 둔 MVP 표
          addM[mid] = { ...x, ...(rid && { room: rid }), ...(round && { round }), ...(lanes && { lanes }), ...(pen && { penalty: { who: pen.who, what: pen.what, t: pen.t } }), ...(mvp && { mvp }) };
          seenId.add(mid); seenKey.add(mKey(x)); imported.matches++;
        }
        if (imported.matches) await redis.hset(K.matches, addM);
        const seenD = new Set(duels.map(d => d.id)), seenDK = new Set(duels.map(dKey)), addD = {};
        for (const d of Array.isArray(b.duels) ? b.duels : []) {
          const a = cleanName(d?.a), bb = cleanName(d?.b), w = cleanName(d?.w), t = Number(d?.t);
          if (!a || !bb || a === bb || ![a, bb].includes(w) || !(t > 0 && t <= Date.now() + 6e4)) continue;
          const x = { t, a, b: bb, w, rule: DUEL_RULES.includes(d.rule) ? d.rule : '자유', ...(okKey(d.by) && { by: d.by }) }, did = okId(d.id) || newId(t, 'd');
          if (gone.has(did)) { imported.gone++; continue; }
          if (seenD.has(did) || seenDK.has(dKey(x)) || duels.length + imported.duels >= MAX_MATCHES) continue;
          addD[did] = x; seenD.add(did); seenDK.add(dKey(x)); imported.duels++;
        }
        if (imported.duels) await redis.hset(K.duels, addD);
        const roster = [...players, ...addP], addR = {};
        for (const [n, e] of Object.entries(b.riot && typeof b.riot === 'object' ? b.riot : {})) {
          const rid = e && cleanRiotId(e.id);
          if (rid && roster.includes(n) && !Object.hasOwn(riotNow, n)) { addR[n] = { id: rid, ...(typeof e.puuid === 'string' && { puuid: e.puuid }), at: 0, gAt: 0 }; imported.riot++; } // 시각을 0으로 둬서 곧 새로 불러와요
        }
        if (imported.riot) await redis.hset(K.riot, addR);
        // 시즌 시작 시각도 지금 없는 것만 더해요(앞날짜는 빼요)
        const seasons = await readSeasons(), addS = [];
        for (const s of Array.isArray(b.seasons) ? b.seasons : []) { const t = Number(s); if (t > 0 && t <= Date.now() && !seasons.includes(t) && !addS.includes(t)) addS.push(t); }
        imported.seasons = addS.length;
        if (addS.length) await redis.set(K.seasons, [...seasons, ...addS].sort((x, y) => x - y));
        // 토너먼트도 지금 없는 것만 다시 만들고, 백업에 있던 판 결과를 순서대로 다시 눌러요(같은 참가 순서라 같은 대진표가 돼요).
        const haveT = new Set((await readTourns()).map(t => t.id)), addT = {};
        imported.tourns = 0;
        for (const x of Array.isArray(b.tourns) ? b.tourns.slice(0, MAX_TOURN) : []) {
          const tid = typeof x?.id === 'string' && /^t[a-z0-9]{4,40}$/.test(x.id) ? x.id : null, name = typeof x?.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 30) : null;
          const ents = Array.isArray(x?.ents) ? x.ents.map(e => cleanNames(e, 5)).filter(e => e?.length) : [], all = ents.flat();
          if (tid && gone.has(tid)) { imported.gone++; continue; }
          if (!tid || haveT.has(tid) || !name || ents.length < 2 || ents.length > 32 || new Set(all).size !== all.length) continue;
          const T = makeTourn(name, typeof x.game === 'string' ? x.game.trim().slice(0, 20) : '', ents);
          if (Number(x.t) > 0) T.t = Number(x.t);
          (Array.isArray(x.rounds) ? x.rounds : []).forEach((rd, r) => (Array.isArray(rd) ? rd : []).forEach((m, i) => {
            const cur = T.rounds[r]?.[i];
            if (cur && !cur.w && cur.a != null && cur.b != null && (m?.w === 'a' || m?.w === 'b')) { cur.w = m.w; tournAdvance(T, r, i); }
          }));
          if (T.doneAt && Number(x.doneAt) > 0) T.doneAt = Number(x.doneAt);
          if (okKey(x.by)) { T.by = x.by; T.byNick = cleanName(x.byNick) || ''; }
          addT[tid] = T; haveT.add(tid); imported.tourns++;
        }
        if (imported.tourns) await redis.hset(K.tourn, addT);
        if (!Object.entries(imported).some(([k, n]) => k !== 'gone' && n)) dup = true;
        break;
      }
      case 'voteMvp': {
        // MVP 투표: 그 판에 뛴 사람 중 한 명. name을 비우면 내 표를 거둬요.
        const mid = typeof b.id === 'string' ? b.id : '', name = b.name == null || b.name === '' ? null : cleanName(b.name);
        if (!me || !mid) return bad(res);
        if (!(await nickOf(me))) return needNick(res);
        const m = parse(await redis.hget(K.matches, mid));
        if (!m) return res.status(404).json({ error: 'no_match' });
        if (Date.now() - m.t > MVP_OPEN) return res.status(409).json({ error: 'mvp_closed' });
        if (name && ![...m.blue, ...m.red].includes(name)) return bad(res);
        const field = `${mid}|${me}`, prev = parse(await redis.hget(K.mvp, field))?.n ?? null;
        if (prev === name) { dup = true; break; }
        if (name) await redis.hset(K.mvp, { [field]: { n: name, t: Date.now() } }); else await redis.hdel(K.mvp, field);
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
        const lanes = cleanLanes(m.lanes, [...blue, ...red]);
        await redis.hset(K.matches, { [id]: { t: now, blue, red, win: m.win, room: room.id, ...(round && { round }), ...(lanes && { lanes }) } });
        await saveRoom({ ...room, lastActive: now });
        notify = matchText({ blue, red, win: m.win, lanes }, room.name);
        await compactMvp(matches); // 하루 지난 판의 MVP 표를 판 기록으로 합쳐요
        break;
      }
      case 'addDuel': {
        // 1:1 한 판: 두 사람과 이긴 사람. 같은 두 사람·같은 결과가 15초 안에 또 오면 두 번 누른 걸로 보고 한 번만 남겨요.
        const [a, bb] = [cleanName(b.a), cleanName(b.b)], w = cleanName(b.win);
        if (!a || !bb || a === bb || ![a, bb].includes(w)) return bad(res);
        // 승리 조건(규칙)은 v1.27.0에서 뺐어요. 예전 기록의 rule은 그대로 남아요.
        const now = Date.now(), duels = await readDuels();
        if (duels.length >= MAX_MATCHES) return res.status(409).json({ error: 'full' });
        const prev = duels.find(d => now - d.t < 15e3 && d.w === w && [d.a, d.b].sort().join() === [a, bb].sort().join());
        if (prev) { id = prev.id; dup = true; break; }
        id = 'd' + now.toString(36) + Math.random().toString(36).slice(2, 6);
        await redis.hset(K.duels, { [id]: { t: now, a, b: bb, w } });
        notify = `⚔️ 1:1 **${w}** 승리 vs ${w === a ? bb : a}`;
        break;
      }
      case 'startSeason': {
        // 새 시즌: 지금 시각을 남겨요. 지금 시즌에 내전·1:1이 한 판도 없으면 막아요(두 번 눌러서 빈 시즌이 생기지 않게).
        const [seasons, matches, duels] = await Promise.all([readSeasons(), readMatches(), readDuels()]);
        const from = seasons.at(-1) || 0, now = Date.now();
        if (!matches.some(m => m.t >= from) && !duels.some(d => d.t >= from)) return res.status(409).json({ error: 'season_empty' });
        await redis.set(K.seasons, [...seasons, now]);
        notify = `🏁 **시즌 ${seasons.length + 2} 시작** · 내전·1:1 MMR이 모두 1000점에서 다시 시작해요`;
        break;
      }
      case 'deleteDuel': {
        // 1:1 기록 지우기(정보 → 1:1 기록): 닉네임을 정한 사람 누구나 해요. 화면에서 두 번 눌러야 지워져요.
        if (typeof b.id !== 'string' || !b.id) return bad(res);
        if (!(await nickOf(me))) return needNick(res);
        await redis.hdel(K.duels, b.id);
        await markGone([b.id]);
        break;
      }
      case 'deleteMatch': {
        if (typeof b.id !== 'string' || !b.id) return bad(res);
        const gone = parse(await redis.hget(K.matches, b.id));
        await redis.hdel(K.matches, b.id);
        await markGone([b.id]); // 백업을 불러와도 되살아나지 않게
        await dropMvp(b.id); // 그 판의 MVP 표도 같이 지워요
        await dropPredRounds([gone?.round]); // 승부 예측도(되돌린 판을 결과 보고 다시 찍지 못하게)
        break;
      }
      case 'current': {
        const c = b.current || {}, blue = cleanNames(c.blue, 10), red = cleanNames(c.red, 10);
        if (!blue || !red) return bad(res);
        const t = Number(c.t) || Date.now();
        const lanes = cleanLanes(c.lanes, [...blue, ...red]), round = Number(c.round) || t;
        // 11명 이상일 때 이번 판에 쉬는 사람(팀에 없는 사람만). 구경하는 화면에도 보여요.
        const bench = (cleanNames(c.bench, MAX_PLAYERS) || []).filter(p => !blue.includes(p) && !red.includes(p));
        // 벌칙 룰렛 결과는 기록된 판의 진 팀 사람(또는 진 팀 전체)일 때만 남겨요. 새로 돌렸으면 디스코드에도 올려요.
        const done = c.penalty && (await readMatches()).find(m => m.round === round);
        const penalty = done && cleanPenalty(c.penalty, done.win === 'blue' ? done.red : done.blue);
        if (penalty && (await redis.get(RK.cur(room.id)))?.penalty?.t !== penalty.t) notify = `🎡 벌칙 당첨 · ${room.name}\n**${penalty.who}** → ${penalty.what}`;
        // 벌칙은 그 판 기록에도 남겨요. 방장이 다음 판으로 넘어가도 기록 탭·이 방 기록에서 누가 무슨 벌칙인지 볼 수 있어요.
        if (penalty && done.penalty?.t !== penalty.t) { const { id: mid, ...rest } = done; await redis.hset(K.matches, { [mid]: { ...rest, penalty: { who: penalty.who, what: penalty.what, t: penalty.t } } }); }
        await redis.set(RK.cur(room.id), { blue, red, t, round, ...(lanes && { lanes }), ...(bench.length && { bench }), ...(penalty && { penalty: { ...penalty, round } }) });
        await saveRoom({ ...room, lastActive: Date.now() });
        break;
      }
      default:
        return bad(res);
    }
    // 바뀌었으면 버전을 올리고 Ably로 '바뀜' 신호를 쏴요(새 상태를 읽는 동안 같이).
    const newVer = dup ? null : await redis.incr(K.ver);
    const [state] = await Promise.all([readState(roomId), newVer != null && ablyPublish(newVer), bv != null && ablyPublish(null, { room: roomId, bv }), notify && discord(notify)]);
    return res.status(200).json({ id, dup, refreshed, more, nick, imported, ...state });
  } catch (e) {
    if (e instanceof RiotError) return res.status(424).json({ error: e.code });
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
