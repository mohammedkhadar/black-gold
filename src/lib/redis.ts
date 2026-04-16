import axios from "axios";
import type { RedisClient } from "./types.js";

export function createRedisClient(url: string | undefined, token: string | undefined): RedisClient {
  const call = (cmd: string[]): Promise<string | null> => {
    if (!url || !token) return Promise.resolve(null);
    return axios
      .post<{ result?: string }>(url, cmd, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      })
      .then((r) => r.data?.result ?? null);
  };

  return {
    async get(key: string): Promise<string | null> {
      try { return await call(["GET", key]); }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] Redis GET failed: ${msg}`);
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      try { await call(["SET", key, value]); }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] Redis SET failed: ${msg}`);
      }
    },
    async append(listKey: string, value: string): Promise<void> {
      try { await call(["RPUSH", listKey, value]); }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] Redis RPUSH failed: ${msg}`);
      }
    },
  };
}
