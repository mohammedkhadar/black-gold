import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTelegramClient } from "../../src/lib/telegram.js";

vi.mock("axios");
import axios from "axios";
const mockPost = vi.mocked(axios.post);

describe("createTelegramClient", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("send does nothing when botToken is missing", async () => {
    const client = createTelegramClient(undefined, "123");
    await client.send("hello");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("send does nothing when chatId is missing", async () => {
    const client = createTelegramClient("bot:token", undefined);
    await client.send("hello");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("send posts to Telegram API with correct payload", async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    const client = createTelegramClient("bot:abc", "999");
    await client.send("<b>BUY signal</b>");
    expect(mockPost).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot:abc/sendMessage",
      { chat_id: "999", text: "<b>BUY signal</b>", parse_mode: "HTML" },
      expect.anything()
    );
  });

  it("send does not throw on network error", async () => {
    mockPost.mockRejectedValueOnce(new Error("connection refused"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createTelegramClient("bot:abc", "999");
    await expect(client.send("test")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[WARN] Telegram notification failed"));
    warnSpy.mockRestore();
  });
});
