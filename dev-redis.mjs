// 시험용 가짜 Redis: @upstash/redis와 같은 모양으로 쓰는 명령만 흉내 내요. 내 컴퓨터 서버(dev-server.mjs)와 시험(tests/)이 같이 써요.
// kv: 키 → 값(그냥 값 / 해시는 Map / 정렬 집합은 isZ가 붙은 Map). onChange: 바뀔 때마다 불러요(파일 저장용).
export const zset = entries => Object.assign(new Map(entries), { isZ: true }); // 정렬 집합(멤버 → 점수)

export function createRedis(kv = new Map(), onChange = () => {}) {
  return {
    // 읽을 땐 복사본을 줘요(진짜 Redis처럼, 받은 값을 고쳐도 저장된 값은 안 바뀌게)
    async get(k) { return structuredClone(kv.get(k) ?? null); },
    async set(k, v) { kv.set(k, structuredClone(v)); onChange(); return 'OK'; },
    async del(...ks) { let n = 0; for (const k of ks) if (kv.delete(k)) n++; onChange(); return n; },
    async hget(k, f) { return structuredClone(kv.get(k)?.get(f) ?? null); },
    async hgetall(k) { const h = kv.get(k); return h?.size ? structuredClone(Object.fromEntries(h)) : null; },
    async hset(k, obj) { const h = kv.get(k) ?? new Map(); for (const [f, v] of Object.entries(obj)) h.set(f, structuredClone(v)); kv.set(k, h); onChange(); return 1; },
    async hdel(k, ...fs) { let n = 0; for (const f of fs) if (kv.get(k)?.delete(f)) n++; onChange(); return n; },
    async incr(k) { const n = (kv.get(k) ?? 0) + 1; kv.set(k, n); onChange(); return n; },
    // zadd(key, [opts], {score, member}, ...)
    async zadd(k, ...args) {
      const opts = args[0] && !('member' in args[0]) ? args.shift() : {}, z = kv.get(k) ?? zset();
      let n = 0;
      for (const { score, member } of args) if (!(opts.nx && z.has(member))) { if (!z.has(member)) n++; z.set(member, score); }
      kv.set(k, z); onChange(); return n;
    },
    async zrem(k, ...members) { const z = kv.get(k); let n = 0; for (const m of members) if (z?.delete(m)) n++; onChange(); return n; },
    // zrange(key, 0, -1, { withScores: true })면 [멤버, 점수, 멤버, 점수, …]
    async zrange(k, _s, _e, opts = {}) { const z = kv.get(k); return z ? [...z].sort((a, b) => a[1] - b[1]).flatMap(([m, s]) => opts.withScores ? [m, s] : [m]) : []; },
    async zremrangebyscore(k, min, max) { const z = kv.get(k); let n = 0; for (const [m, s] of z || []) if (s >= min && s <= max) { z.delete(m); n++; } onChange(); return n; },
    async zscore(k, m) { return kv.get(k)?.get(m) ?? null; },
  };
}
