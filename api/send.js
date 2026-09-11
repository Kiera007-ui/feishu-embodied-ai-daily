import crypto from "node:crypto";

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TEXT_LENGTH = 12000;
const recentSends = globalThis.__feishuDailyRecentSends || new Map();
globalThis.__feishuDailyRecentSends = recentSends;

function cleanup(now) {
  for (const [key, ts] of recentSends.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) recentSends.delete(key);
  }
}

function messageKey(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function buildFeishuCard(text) {
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "具身智能每日推" },
        template: "blue"
      },
      elements: [
        {
          tag: "div",
          text: { tag: "lark_md", content: text }
        }
      ]
    }
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "GET") {
    return res.status(405).json({ ok: false, error: "GET does not send messages. Use POST." });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "Message text is required" });
  if (!text.startsWith("具身智能每日推｜")) {
    return res.status(400).json({ ok: false, error: "Message must start with 具身智能每日推｜" });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(413).json({ ok: false, error: "Message is too long" });
  }
  if (!process.env.FEISHU_WEBHOOK_URL) {
    return res.status(500).json({ ok: false, error: "FEISHU_WEBHOOK_URL is not configured" });
  }

  const now = Date.now();
  cleanup(now);
  const key = messageKey(text);

  if (recentSends.has(key)) {
    return res.status(200).json({ ok: true, deduped: true, message: "Duplicate suppressed" });
  }

  // Lock before the outbound request so rapid repeated POSTs in the same warm instance
  // cannot fan out to Feishu. If the outbound request fails, release the lock.
  recentSends.set(key, now);

  try {
    const response = await fetch(process.env.FEISHU_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(buildFeishuCard(text))
    });

    const raw = await response.text();
    let feishu;
    try {
      feishu = JSON.parse(raw);
    } catch {
      feishu = { raw };
    }

    const failed = !response.ok ||
      (feishu?.code != null && feishu.code !== 0) ||
      (feishu?.StatusCode != null && feishu.StatusCode !== 0);

    if (failed) {
      recentSends.delete(key);
      return res.status(502).json({ ok: false, error: "Feishu webhook failed", feishu });
    }

    return res.status(200).json({ ok: true, deduped: false, feishu });
  } catch (error) {
    recentSends.delete(key);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
