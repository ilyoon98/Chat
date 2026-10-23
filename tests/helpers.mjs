// 서버 시험 도우미: 가짜 Redis(dev-redis.mjs)를 끼운 채로 api/data.js를 바로 불러요. 실제 DB·인터넷은 안 써요.
import { createRedis } from '../dev-redis.mjs';

export const kv = new Map();
globalThis.__redis = createRedis(kv);
const { default: handler } = await import('../api/data.js');

export const reset = () => kv.clear();
export const HOST = 'hostdevice01', GUEST = 'guestdevice1', OTHER = 'otherdevice1';

async function run(req) {
  let status = 200, body;
  const res = { setHeader() {}, status(c) { status = c; return res; }, json(o) { body = o; return res; } };
  await handler(req, res);
  return { status, body: body && structuredClone(body) };
}
export const post = (body, device = HOST, headers = {}) => run({ method: 'POST', url: '/api/data', headers: { 'x-device': device, ...headers }, body });
export const get = (query = '') => run({ method: 'GET', url: '/api/data' + (query ? '?' + query : ''), headers: {} });

// 자주 쓰는 준비: 닉네임 정하기 → 방 만들기(방장) → 명단 넣기
export async function setup(players = ['가', '나', '다', '라']) {
  await post({ action: 'claimNick', nick: '방장' }, HOST);
  const room = (await post({ action: 'createRoom', nick: '방장' }, HOST)).body.id;
  await post({ action: 'addPlayers', names: players }, HOST);
  return room;
}
export async function record(room, { blue = ['가', '나'], red = ['다', '라'], win = 'blue', round = Date.now() + Math.random() } = {}) {
  const r = await post({ action: 'addMatch', room, match: { blue, red, win, round } }, HOST);
  return r.body.id;
}
// 판 시각을 옛날로 돌려요(투표 마감·정리 시험용)
export function age(matchId, ms) { const m = kv.get('lol:matches').get(matchId); m.t -= ms; }
export const DAY = 864e5;
