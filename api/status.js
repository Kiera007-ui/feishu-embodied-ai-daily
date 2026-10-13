export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({
    ok: true,
    version: "cloud-only-v3",
    architecture: "vercel-cron -> github-cloud-daily -> vercel-relay -> feishu",
    sender: "cloud-daily.yml",
    manual_send_enabled: false,
    queue_send_enabled: false,
    feishu_webhook_configured: Boolean(process.env.FEISHU_WEBHOOK_URL)
  });
}
