export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const ready = Boolean(
    process.env.OPENAI_API_KEY &&
    process.env.FEISHU_WEBHOOK_URL &&
    process.env.CRON_SECRET
  );
  return res.status(200).json({
    ok: true,
    version: "server-cron-v2",
    auto_push_ready: ready,
    auto_push_disabled: process.env.AUTO_PUSH_DISABLED === "1"
  });
}
