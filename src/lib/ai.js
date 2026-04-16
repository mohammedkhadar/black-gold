import axios from "axios";

const OPENROUTER_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];
const GROQ_MODEL = "openai/gpt-oss-120b";

/**
 * Call the AI with up to 3 attempts:
 *   Attempts 1 & 2 → OpenRouter Nemotron (with json_object response_format)
 *   Attempt 3      → Groq gpt-oss-120b (no response_format, uses regex fallback)
 *
 * Returns { aiSignal, aiScore, reasoning, aiAvailable }
 */
export async function callAI(prompt, openrouterKey, groqKey) {
  let parsed;
  let aiAvailable = true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let content = "";
    try {
      const useGroq = attempt === 3;
      const res = await axios.post(
        useGroq
          ? "https://api.groq.com/openai/v1/chat/completions"
          : "https://openrouter.ai/api/v1/chat/completions",
        {
          model: useGroq ? GROQ_MODEL : OPENROUTER_MODELS[attempt - 1],
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
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
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[WARN] All AI attempts failed (${err.message}) — defaulting to HOLD.`);
        break;
      }
      console.warn(`[WARN] OpenRouter attempt ${attempt} (${OPENROUTER_MODELS[attempt - 1]}) failed (${err.message}) — retrying …`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }

    // Parse the response — try strict JSON first, then regex fallback
    try {
      parsed = JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
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

  return {
    aiSignal:    ["BUY", "HOLD", "SELL"].includes(parsed.signal) ? parsed.signal : "HOLD",
    aiScore:     typeof parsed.netScore === "number" ? parsed.netScore : 0,
    reasoning:   parsed.reasoning ?? "",
    aiAvailable,
  };
}
