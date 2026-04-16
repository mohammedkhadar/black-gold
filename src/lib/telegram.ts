import axios from "axios";
import type { TelegramClient } from "./types.js";

export function createTelegramClient(botToken: string | undefined, chatId: string | undefined): TelegramClient {
  return {
    async send(text: string): Promise<void> {
      if (!botToken || !chatId) return;
      try {
        await axios.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          { chat_id: chatId, text, parse_mode: "HTML" },
          { timeout: 10000 }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] Telegram notification failed: ${msg}`);
      }
    },
  };
}
