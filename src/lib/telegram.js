import axios from "axios";

export function createTelegramClient(botToken, chatId) {
  return {
    async send(text) {
      if (!botToken || !chatId) return;
      try {
        await axios.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          { chat_id: chatId, text, parse_mode: "HTML" },
          { timeout: 10000 }
        );
      } catch (err) {
        console.warn(`[WARN] Telegram notification failed: ${err.message}`);
      }
    },
  };
}
