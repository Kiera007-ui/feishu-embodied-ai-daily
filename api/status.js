export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const config = {
    feishu_webhook: Boolean(process.env.FEISHU_WEBHOOK_URL),
    openai_api_key: Boolean(process.env.OPENAI_API_KEY),
    cron_secret: Boolean(process.env.CRON_SECRET),
    manual_secret: Boolean(process.env.MANUAL_SECRET)
  };
  return res.status(200).json({
    ok: true,
    version: "server-cron-v2",
    auto_push_ready: config.feishu_webhook && config.openai_api_key && config.cron_secret,
    auto_push_disabled: process.env.AUTO_PUSH_DISABLED === "1",
    config
  });
}
