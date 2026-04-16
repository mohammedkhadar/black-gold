import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRedisClient } from "../../src/lib/redis.js";

// Mock axios at the module level
vi.mock("axios");
import axios from "axios";
const mockPost = vi.mocked(axios.post);

describe("createRedisClient", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("get returns null when url/token are missing", async () => {
    const client = createRedisClient(undefined, undefined);
    const result = await client.get("key");
    expect(result).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("get calls Upstash REST API with GET command", async () => {
    mockPost.mockResolvedValueOnce({ data: { result: "cached_value" } });
    const client = createRedisClient("https://redis.example.com", "tok");
    const result = await client.get("btc:lastNewsHash");
    expect(mockPost).toHaveBeenCalledWith(
      "https://redis.example.com",
      ["GET", "btc:lastNewsHash"],
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) })
    );
    expect(result).toBe("cached_value");
  });

  it("get returns null on network error", async () => {
    mockPost.mockRejectedValueOnce(new Error("network error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createRedisClient("https://redis.example.com", "tok");
    const result = await client.get("key");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[WARN] Redis GET failed"));
    warnSpy.mockRestore();
  });

  it("set calls Upstash REST API with SET command", async () => {
    mockPost.mockResolvedValueOnce({ data: { result: "OK" } });
    const client = createRedisClient("https://redis.example.com", "tok");
    await client.set("btc:lastNewsHash", "abc123");
    expect(mockPost).toHaveBeenCalledWith(
      "https://redis.example.com",
      ["SET", "btc:lastNewsHash", "abc123"],
      expect.anything()
    );
  });

  it("set does not throw on network error", async () => {
    mockPost.mockRejectedValueOnce(new Error("timeout"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createRedisClient("https://redis.example.com", "tok");
    await expect(client.set("key", "val")).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it("append calls Upstash REST API with RPUSH command", async () => {
    mockPost.mockResolvedValueOnce({ data: { result: 1 } });
    const client = createRedisClient("https://redis.example.com", "tok");
    await client.append("btc:history", '{"signal":"BUY"}');
    expect(mockPost).toHaveBeenCalledWith(
      "https://redis.example.com",
      ["RPUSH", "btc:history", '{"signal":"BUY"}'],
      expect.anything()
    );
  });

  it("append does not throw on network error", async () => {
    mockPost.mockRejectedValueOnce(new Error("timeout"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createRedisClient("https://redis.example.com", "tok");
    await expect(client.append("key", "val")).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});
