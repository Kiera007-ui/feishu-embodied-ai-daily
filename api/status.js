export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({
    ok: true,
    version: "github-queue-relay-v1",
    architecture: "chatgpt-schedule -> github-queue -> github-actions-oidc -> vercel-relay -> feishu",
    browser_automation_required: false,
    feishu_webhook_configured: Boolean(process.env.FEISHU_WEBHOOK_URL)
  });
}
