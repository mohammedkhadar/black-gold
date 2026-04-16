import axios from "axios";

export function createRedisClient(url, token) {
  const call = (cmd) => {
    if (!url || !token) return Promise.resolve(null);
    return axios
      .post(url, cmd, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
      .then((r) => r.data?.result ?? null);
  };

  return {
    async get(key) {
      try { return await call(["GET", key]); }
      catch (err) { console.warn(`[WARN] Redis GET failed: ${err.message}`); return null; }
    },
    async set(key, value) {
      try { await call(["SET", key, String(value)]); }
      catch (err) { console.warn(`[WARN] Redis SET failed: ${err.message}`); }
    },
    async append(listKey, value) {
      try { await call(["RPUSH", listKey, String(value)]); }
      catch (err) { console.warn(`[WARN] Redis RPUSH failed: ${err.message}`); }
    },
  };
}
