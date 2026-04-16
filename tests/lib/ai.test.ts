import { describe, it, expect, vi, beforeEach } from "vitest";
import { callAI } from "../../src/lib/ai.js";

vi.mock("axios");
import axios from "axios";
const mockPost = vi.mocked(axios.post);

const validResponse = (signal: string, netScore: number, reasoning: string) => ({
  data: {
    choices: [
      {
        message: {
          content: JSON.stringify({ signal, netScore, reasoning }),
        },
      },
    ],
  },
});

describe("callAI", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns parsed BUY signal on first attempt", async () => {
    mockPost.mockResolvedValueOnce(validResponse("BUY", 55, "Strong momentum."));
    const result = await callAI("prompt", "or-key", "groq-key");
    expect(result.aiSignal).toBe("BUY");
    expect(result.aiScore).toBe(55);
    expect(result.reasoning).toBe("Strong momentum.");
    expect(result.aiAvailable).toBe(true);
  });

  it("returns parsed SELL signal", async () => {
    mockPost.mockResolvedValueOnce(validResponse("SELL", -42, "Bearish outlook."));
    const result = await callAI("prompt", "or-key", "groq-key");
    expect(result.aiSignal).toBe("SELL");
    expect(result.aiScore).toBe(-42);
  });

  it("returns HOLD on invalid signal string", async () => {
    mockPost.mockResolvedValueOnce({
      data: { choices: [{ message: { content: JSON.stringify({ signal: "UNKNOWN", netScore: 10, reasoning: "?" }) } }] },
    });
    const result = await callAI("prompt", "or-key", "groq-key");
    expect(result.aiSignal).toBe("HOLD");
  });

  it("retries on failure and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    mockPost
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(validResponse("HOLD", 0, "Neutral."));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resultPromise = callAI("prompt", "or-key", "groq-key");
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.aiSignal).toBe("HOLD");
    expect(result.aiAvailable).toBe(true);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("falls back to HOLD with aiAvailable=false when all 3 attempts fail", async () => {
    vi.useFakeTimers();
    mockPost.mockRejectedValue(new Error("service down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resultPromise = callAI("prompt", "or-key", "groq-key");
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.aiSignal).toBe("HOLD");
    expect(result.aiScore).toBe(0);
    expect(result.aiAvailable).toBe(false);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("handles regex fallback when response is not valid JSON", async () => {
    mockPost.mockResolvedValueOnce({
      data: { choices: [{ message: { content: "The signal is BUY with a score of 30 based on market trends." } }] },
    });
    const result = await callAI("prompt", "or-key", "groq-key");
    expect(result.aiSignal).toBe("BUY");
    expect(result.aiAvailable).toBe(true);
  });

  it("handles JSON embedded in markdown fences", async () => {
    const embeddedJson = "```json\n{\"signal\":\"SELL\",\"netScore\":-20,\"reasoning\":\"Bearish.\"}\n```";
    mockPost.mockResolvedValueOnce({
      data: { choices: [{ message: { content: embeddedJson } }] },
    });
    const result = await callAI("prompt", "or-key", "groq-key");
    expect(result.aiSignal).toBe("SELL");
    expect(result.aiScore).toBe(-20);
  });
});
