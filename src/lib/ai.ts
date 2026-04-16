import axios from "axios";
import type { AIResult } from "./types.js";

const OPENROUTER_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",  // attempt 1 — Nemotron
] as const;
const GROQ_MODEL = "openai/gpt-oss-120b"; // attempt 2 — Groq (separate infrastructure)

interface ParsedAIResponse {
  signal?: unknown;
  netScore?: unknown;
  reasoning?: unknown;
}

/**
 * Call the AI with up to 2 attempts:
 *   Attempt 1 → OpenRouter (Nemotron free)
 *   Attempt 2 → Groq openai/gpt-oss-120b (separate infrastructure)
 */
export async function callAI(
  prompt: string,
  openrouterKey: string,
  groqKey: string
): Promise<AIResult> {
  let parsed: ParsedAIResponse | null = null;
  let aiAvailable = true;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let content = "";
    try {
      const useGroq = attempt === 2;
      const res = await axios.post<{ choices: Array<{ message?: { content?: string } }> }>(
        useGroq
          ? "https://api.groq.com/openai/v1/chat/completions"
          : "https://openrouter.ai/api/v1/chat/completions",
        {
          model: useGroq ? GROQ_MODEL : OPENROUTER_MODELS[attempt - 1],
          messages: [{ role: "user", content: prompt }],
          max_tokens: useGroq ? 800 : 300, // Groq gpt-oss-120b is a reasoning model; needs extra budget
          temperature: 0.2,
          ...(useGroq ? {} : { response_format: { type: "json_object" } }),
        },
        {
          headers: {
            Authorization: `Bearer ${useGroq ? groqKey : openrouterKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );
      content = res.data.choices[0]?.message?.content?.trim() ?? "";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 2) {
        console.warn(`[WARN] All AI attempts failed (${msg}) — defaulting to HOLD.`);
        break;
      }
      console.warn(`[WARN] Attempt ${attempt} (${OPENROUTER_MODELS[attempt - 1]}) failed (${msg}) — retrying …`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }

    // Parse response — try strict JSON first, then regex fallback
    try {
      parsed = JSON.parse(content) as ParsedAIResponse;
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]) as ParsedAIResponse; } catch { /* fall through */ }
      }
      if (!parsed) {
        const sigMatch = content.match(/\b(BUY|SELL|HOLD)\b/i);
        if (sigMatch) {
          const scoreMatch = content.match(/[-+]?\d+/);
          parsed = {
            signal:    sigMatch[1].toUpperCase(),
            netScore:  scoreMatch ? parseInt(scoreMatch[0], 10) : 0,
            reasoning: content.slice(0, 120).replace(/\n/g, " "),
          };
        }
      }
    }

    if (parsed) break;
    console.warn(`[WARN] Attempt ${attempt}: unparseable response ("${content.slice(0, 60)}") — retrying …`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }

  if (!parsed) {
    console.warn("[WARN] AI signal unavailable — defaulting to HOLD with score 0.");
    parsed = { signal: "HOLD", netScore: 0, reasoning: "AI unavailable — rate limited." };
    aiAvailable = false;
  }

  const signal = String(parsed.signal ?? "");

  // Sanitise reasoning: if it starts with '{' the fallback path captured raw JSON — unwrap it
  let reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  if (reasoning.trimStart().startsWith("{")) {
    try {
      const inner = JSON.parse(reasoning) as ParsedAIResponse;
      reasoning = typeof inner.reasoning === "string" ? inner.reasoning : reasoning;
    } catch { /* leave as-is */ }
  }
  // Truncate runaway strings
  if (reasoning.length > 200) reasoning = reasoning.slice(0, 200).trimEnd() + "…";

  return {
    aiSignal:    ["BUY", "HOLD", "SELL"].includes(signal) ? signal : "HOLD",
    aiScore:     typeof parsed.netScore === "number" ? parsed.netScore : 0,
    reasoning,
    aiAvailable,
  };
}
