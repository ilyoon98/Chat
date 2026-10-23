// 서버(api/data.js) 시험: npm test 로 한 번에 돌려요. 가짜 Redis라서 실제 사이트 기록은 안 건드려요.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { kv, reset, post, get, setup, record, age, DAY, HOST, GUEST, OTHER } from './helpers.mjs';

beforeEach(reset);

// ---------- 기본 ----------
test('빈 DB에서도 상태를 읽어요', async () => {
  const r = await get();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.players, []);
  assert.equal(r.body.ver, 0);
});

test('버전이 같으면 "같아요"만 답해요', async () => {
  await setup();
  const { ver } = (await get()).body;
  assert.equal((await get(`v=${ver}`)).body.same, true);
  await post({ action: 'addPlayers', names: ['마'] }, GUEST);
  assert.notEqual((await get(`v=${ver}`)).body.same, true);
});

test('같은 닉네임은 다른 기기에 번호를 붙여 줘요', async () => {
  assert.equal((await post({ action: 'claimNick', nick: '일윤' }, HOST)).body.nick, '일윤');
  assert.equal((await post({ action: 'claimNick', nick: '일윤' }, GUEST)).body.nick, '일윤 2');
  assert.equal((await post({ action: 'claimNick', nick: '일윤' }, HOST)).body.nick, '일윤'); // 내 닉네임은 그대로
});

// ---------- 방·방장 ----------
test('방장만 오늘 할 사람·팀·승패를 바꿔요', async () => {
  const room = await setup();
  assert.equal((await post({ action: 'select', room, names: ['가'] }, GUEST)).status, 423);
  assert.equal((await post({ action: 'select', room, names: ['가'] }, HOST)).status, 200);
  assert.equal((await post({ action: 'addMatch', room, match: { blue: ['가'], red: ['나'], win: 'blue' } }, GUEST)).status, 423);
});

test('같은 판(round)은 한 번만 기록되고, 새 판은 따로 기록돼요', async () => {
  const room = await setup();
  const a = await post({ action: 'addMatch', room, match: { blue: ['가'], red: ['나'], win: 'blue', round: 111 } });
  const b = await post({ action: 'addMatch', room, match: { blue: ['가'], red: ['나'], win: 'red', round: 111 } });
  assert.equal(b.body.dup, true);
  assert.equal(b.body.id, a.body.id);
  await post({ action: 'addMatch', room, match: { blue: ['가'], red: ['나'], win: 'blue', round: 222 } });
  assert.equal((await get()).body.matches.length, 2);
});

test('참가 신청은 방장이 아니어도 명단에 있는 이름만 돼요', async () => {
  const room = await setup();
  assert.equal((await post({ action: 'selfSelect', room, name: '가' }, GUEST)).status, 200);
  assert.equal((await post({ action: 'selfSelect', room, name: '없는사람' }, GUEST)).status, 400);
  assert.deepEqual((await get(`room=${room}`)).body.room.selected, ['가']);
});

// ---------- 명단 ----------
test('이미 있는 이름으로 바꾸면 전적이 합쳐지고, 같이 뛴 사이는 못 합쳐요', async () => {
  const room = await setup();
  await record(room, { blue: ['가'], red: ['나'] });
  assert.equal((await post({ action: 'renamePlayer', from: '가', to: '나' })).status, 422);
  await record(room, { blue: ['다'], red: ['라'] });
  const r = await post({ action: 'renamePlayer', from: '다', to: '가' });
  assert.equal(r.status, 200);
  assert.ok(!r.body.players.includes('다'));
  assert.ok(r.body.matches.some(m => m.blue.includes('가') && m.red.includes('라')));
});

// ---------- 기록 지우기 ----------
test('판을 지우면 그 판의 MVP 표와 승부 예측도 같이 지워요', async () => {
  const room = await setup();
  await post({ action: 'claimNick', nick: '손님' }, GUEST);
  await post({ action: 'current', room, current: { blue: ['가', '나'], red: ['다', '라'], t: 5, round: 777 } });
  await post({ action: 'predict', room, round: 777, side: 'blue' }, GUEST);
  const id = await record(room, { round: 777 });
  await post({ action: 'voteMvp', id, name: '가' }, GUEST);
  const r = await post({ action: 'deleteMatch', id });
  assert.deepEqual(r.body.mvp, {});
  assert.deepEqual(r.body.pred, []);
});

test('기록 지우기는 어느 방이든 방장만 돼요', async () => {
  const room = await setup();
  const id = await record(room);
  assert.equal((await post({ action: 'deleteMatch', id }, GUEST)).status, 423);
  assert.equal((await post({ action: 'deleteMatch', id }, HOST)).status, 200);
});

// ---------- MVP 투표 ----------
test('MVP는 한 기기에 한 표, 옮기고 거둘 수 있어요', async () => {
  const room = await setup();
  await post({ action: 'claimNick', nick: '손님' }, GUEST);
  const id = await record(room);
  assert.deepEqual((await post({ action: 'voteMvp', id, name: '가' }, GUEST)).body.mvp[id], { 가: 1 });
  assert.deepEqual((await post({ action: 'voteMvp', id, name: '다' }, GUEST)).body.mvp[id], { 다: 1 });
  assert.equal((await post({ action: 'voteMvp', id, name: '다' }, GUEST)).body.dup, true);
  assert.equal((await post({ action: 'voteMvp', id, name: '없는사람' }, GUEST)).status, 400);
  assert.equal((await post({ action: 'voteMvp', id, name: null }, GUEST)).body.mvp[id], undefined);
});

test('MVP 투표는 기록하고 하루가 지나면 마감돼요', async () => {
  const room = await setup();
  const id = await record(room);
  age(id, DAY + 1000);
  const r = await post({ action: 'voteMvp', id, name: '가' }, HOST);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'mvp_closed');
});

test('닉네임을 안 정한 기기는 MVP 투표를 못 해요', async () => {
  const room = await setup();
  const id = await record(room);
  const r = await post({ action: 'voteMvp', id, name: '가' }, OTHER);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'need_nick');
});

test('투표가 끝난 판의 표는 판 기록 안으로 합쳐지고, 표 수는 그대로 보여요', async () => {
  const room = await setup();
  await post({ action: 'claimNick', nick: '손님' }, GUEST);
  const id = await record(room);
  await post({ action: 'voteMvp', id, name: '가' }, GUEST);
  await post({ action: 'voteMvp', id, name: '가' }, HOST);
  age(id, DAY + 1000);
  const r = await record(room, { blue: ['다'], red: ['라'] }) && await get();
  assert.deepEqual(r.body.mvp[id], { 가: 2 });
  assert.equal(kv.get('lol:mvp')?.size || 0, 0); // 표 해시는 비었어요
  assert.deepEqual(kv.get('lol:matches').get(id).mvp, { 가: 2 });
});

test('매일 새벽 Cron도 끝난 MVP 표를 판 기록으로 합쳐요', async () => {
  const room = await setup();
  const id = await record(room);
  await post({ action: 'voteMvp', id, name: '라' }, HOST);
  age(id, DAY + 1000);
  await get('cron=riot'); // Riot 키가 없어도 MVP 정리는 해요
  assert.deepEqual(kv.get('lol:matches').get(id).mvp, { 라: 1 });
  assert.deepEqual((await get()).body.mvp[id], { 라: 1 });
});

test('판이 없어진 표도 정리돼요', async () => {
  const room = await setup();
  const id = await record(room);
  await post({ action: 'voteMvp', id, name: '가' }, HOST);
  kv.get('lol:matches').delete(id); // 예전 버전에서 판만 지워지고 표가 남은 경우
  await record(room);
  assert.equal(kv.get('lol:mvp')?.size || 0, 0);
});

test('이름을 바꾸면 합쳐 둔 MVP 표 이름도 바뀌어요', async () => {
  const room = await setup();
  const id = await record(room);
  await post({ action: 'voteMvp', id, name: '가' }, HOST);
  age(id, DAY + 1000);
  await record(room);
  const r = await post({ action: 'renamePlayer', from: '가', to: '마' });
  assert.deepEqual(r.body.mvp[id], { 마: 1 });
});

// ---------- 승부 예측 ----------
async function readyRound(room, round = 900) {
  await post({ action: 'current', room, current: { blue: ['가', '나'], red: ['다', '라'], t: round, round } });
  return round;
}

test('승부 예측 이름은 서버에 정해 둔 닉네임으로 남아요(다른 사람 이름으로 못 찍어요)', async () => {
  const room = await setup();
  await post({ action: 'claimNick', nick: '손님' }, GUEST);
  const round = await readyRound(room);
  const r = await post({ action: 'predict', room, round, side: 'red', nick: '방장' }, GUEST);
  assert.equal(r.status, 200);
  assert.equal(r.body.pred[0].n, '손님');
});

test('닉네임을 안 정한 기기는 승부 예측을 못 해요', async () => {
  const room = await setup();
  const round = await readyRound(room);
  const r = await post({ action: 'predict', room, round, side: 'red', nick: '아무개' }, OTHER);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'need_nick');
});

test('팀이 바뀌었거나 결과가 나온 판은 예측이 막혀요', async () => {
  const room = await setup();
  await post({ action: 'claimNick', nick: '손님' }, GUEST);
  const round = await readyRound(room);
  assert.equal((await post({ action: 'predict', room, round: round + 1, side: 'red' }, GUEST)).body.error, 'pred_stale');
  await record(room, { round });
  assert.equal((await post({ action: 'predict', room, round, side: 'red' }, GUEST)).body.error, 'pred_closed');
});

test('예측·참가 신청은 그 방 버전만 올려요(다른 방 화면은 다시 안 받아요)', async () => {
  const room = await setup();
  await post({ action: 'claimNick', nick: '손님' }, GUEST);
  const round = await readyRound(room);
  const before = (await get(`room=${room}`)).body;
  const p = await post({ action: 'predict', room, round, side: 'blue' }, GUEST);
  assert.equal(p.body.ver, before.ver);
  assert.ok(p.body.room.bver > before.room.bver);
  const s = await post({ action: 'selfSelect', room, name: '가' }, GUEST);
  assert.equal(s.body.ver, before.ver);
  assert.ok(s.body.room.bver > p.body.room.bver);
  assert.deepEqual(s.body.room.selected, ['가']);
});

// ---------- 벌칙 ----------
test('벌칙은 진 팀 사람만 받고, 그 판 기록에도 남아요', async () => {
  const room = await setup();
  const id = await record(room, { round: 50, win: 'blue' });
  const cur = { blue: ['가', '나'], red: ['다', '라'], t: 60, round: 50 };
  const w = await post({ action: 'current', room, current: { ...cur, penalty: { who: '가', what: '음료수', t: 1 } } });
  assert.equal(w.body.room.current.penalty, undefined);
  const l = await post({ action: 'current', room, current: { ...cur, t: 61, penalty: { who: '다', what: '음료수', t: 2 } } });
  assert.equal(l.body.room.current.penalty.who, '다');
  assert.equal(l.body.matches.find(m => m.id === id).penalty.what, '음료수');
});

// ---------- 백업 불러오기 ----------
test('백업 불러오기는 지금 없는 것만 더해요', async () => {
  const room = await setup();
  await record(room);
  const backup = (await get()).body;
  const extra = { id: 'old111', t: Date.now() - DAY, blue: ['가'], red: ['나'], win: 'red' };
  const r = await post({ action: 'importBackup', players: [...backup.players, '마'], matches: [...backup.matches, extra], duels: [] });
  assert.equal(r.body.imported.players, 1);
  assert.equal(r.body.imported.matches, 1);
  const again = await post({ action: 'importBackup', players: backup.players, matches: [...backup.matches, extra] });
  assert.equal(again.body.dup, true);
});

test('일부러 지운 판·1:1·토너먼트는 백업을 불러와도 되살아나지 않아요', async () => {
  const room = await setup();
  const keep = await record(room), gone = await record(room, { blue: ['다'], red: ['라'] });
  const duel = (await post({ action: 'addDuel', a: '가', b: '나', win: '가' })).body.id;
  const tourn = (await post({ action: 'createTourn', name: '컵', entrants: [['가'], ['나']] })).body.id;
  const backup = (await get()).body;
  await post({ action: 'deleteMatch', id: gone });
  await post({ action: 'deleteDuel', id: duel });
  await post({ action: 'deleteTourn', id: tourn });
  const r = await post({ action: 'importBackup', players: backup.players, matches: backup.matches, duels: backup.duels, tourns: backup.tourns });
  assert.equal(r.body.imported.matches, 0);
  assert.equal(r.body.imported.duels, 0);
  assert.equal(r.body.imported.tourns, 0);
  assert.equal(r.body.imported.gone, 3); // 지운 것 3개는 빼고 불러왔다고 알려 줘요
  assert.deepEqual(r.body.matches.map(m => m.id), [keep]);
});

test('여러 판 한 번에 지운 것도 백업으로 되살아나지 않아요', async () => {
  const room = await setup();
  const a = await record(room), b = await record(room, { blue: ['다'], red: ['라'] });
  const backup = (await get()).body;
  await post({ action: 'deleteMatches', ids: [a, b] });
  const r = await post({ action: 'importBackup', players: backup.players, matches: backup.matches });
  assert.equal(r.body.imported.gone, 2);
  assert.equal(r.body.matches.length, 0);
});

test('전체 초기화 뒤에는 미리 받은 백업으로 다 되살릴 수 있어요', async () => {
  const room = await setup();
  await record(room); await record(room, { blue: ['다'], red: ['라'] });
  const backup = (await get()).body;
  await post({ action: 'resetRecords', confirm: '초기화' });
  const r = await post({ action: 'importBackup', players: backup.players, matches: backup.matches });
  assert.equal(r.body.imported.matches, 2);
});

test('백업에 들어 있던 MVP 표 수도 되살려요', async () => {
  const room = await setup();
  const id = await record(room);
  await post({ action: 'voteMvp', id, name: '나' }, HOST);
  age(id, DAY + 1000);
  await record(room);
  const backup = (await get()).body;
  await post({ action: 'resetRecords', confirm: '초기화' });
  const r = await post({ action: 'importBackup', players: backup.players, matches: backup.matches });
  assert.deepEqual(r.body.mvp[id], { 나: 1 });
});

// ---------- 시즌·토너먼트·타이머 ----------
test('판이 없는 시즌은 새로 시작할 수 없어요', async () => {
  const room = await setup();
  assert.equal((await post({ action: 'startSeason' })).body.error, 'season_empty');
  await record(room);
  assert.equal((await post({ action: 'startSeason' })).status, 200);
});

test('토너먼트: 이긴 쪽이 올라가고 결승 승자가 우승이에요', async () => {
  await setup();
  const id = (await post({ action: 'createTourn', name: '컵', entrants: [['가'], ['나'], ['다'], ['라']] })).body.id;
  await post({ action: 'tournWin', id, r: 0, i: 0, w: 'a' });
  await post({ action: 'tournWin', id, r: 0, i: 1, w: 'b' });
  const r = await post({ action: 'tournWin', id, r: 1, i: 0, w: 'b' });
  const T = r.body.tourns.find(t => t.id === id);
  assert.deepEqual(T.ents[T.champ], ['라']);
  assert.equal((await post({ action: 'tournWin', id, r: 0, i: 0, w: 'b' })).body.error, 'tourn_locked');
});

test('인게임 타이머는 누구나 쓰고, 그 방 버전만 올려요', async () => {
  const room = await setup();
  const before = (await get(`room=${room}`)).body;
  const r = await post({ action: 'board', room, side: 'blue', op: 'obj', key: 'baron', dur: 360 }, OTHER);
  assert.equal(r.status, 200);
  assert.equal(r.body.ver, before.ver);
  assert.ok(r.body.room.boards.blue['o:baron'] > Date.now());
});

test('RECORD_PIN을 걸면 기록은 비밀번호가 필요하고, 투표·예측·타이머는 그대로 돼요', async () => {
  const room = await setup();
  const id = await record(room);
  process.env.RECORD_PIN = '1234';
  try {
    assert.equal((await post({ action: 'addPlayers', names: ['마'] })).status, 401);
    assert.equal((await post({ action: 'addPlayers', names: ['마'] }, HOST, { 'x-pin': '1234' })).status, 200);
    assert.equal((await post({ action: 'voteMvp', id, name: '가' }, HOST)).status, 200);
    assert.equal((await post({ action: 'board', room, side: 'red', op: 'reset' }, HOST)).status, 200);
  } finally { delete process.env.RECORD_PIN; }
});
