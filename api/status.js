import { ALLOWED_SOURCE_NAMES } from "../lib/source-policy.js";
import { MAX_ITEMS_PER_TOPIC } from "../lib/editorial-policy.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({
    ok: true,
    version: "cloud-only-label-cap-v6",
    max_items_per_topic: MAX_ITEMS_PER_TOPIC,
    topic_limit_basis: "final_display_tag",
    architecture: "vercel-cron -> github-cloud-daily -> vercel-relay -> feishu",
    sender: "cloud-daily.yml",
    manual_send_enabled: false,
    queue_send_enabled: false,
    allowed_publishers: ALLOWED_SOURCE_NAMES,
    approved_publisher_reposts_allowed: true,
    feishu_webhook_configured: Boolean(process.env.FEISHU_WEBHOOK_URL)
  });
}
