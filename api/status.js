export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const config = {
    feishu_webhook: Boolean(process.env.FEISHU_WEBHOOK_URL),
    ai_gateway_auth: Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY),
    cron_secret: Boolean(process.env.CRON_SECRET),
    manual_secret: Boolean(process.env.MANUAL_SECRET)
  };
  return res.status(200).json({
    ok: true,
    version: "server-cron-v3-gateway",
    auto_push_ready: config.feishu_webhook && config.ai_gateway_auth && config.cron_secret,
    auto_push_disabled: process.env.AUTO_PUSH_DISABLED === "1",
    config
  });
}
