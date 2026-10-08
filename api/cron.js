// Vercel Cron calls this once a day (09:00-09:59 Beijing on the Hobby plan).
// It only asks GitHub to start the daily workflow; GitHub does the work.
const REPOSITORY = "Kiera007-ui/feishu-embodied-ai-daily";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: "CRON_SECRET is not configured" });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!process.env.GITHUB_DISPATCH_TOKEN) {
    return res.status(503).json({ ok: false, error: "GITHUB_DISPATCH_TOKEN is not configured" });
  }

  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "feishu-embodied-ai-daily-cron"
    },
    body: JSON.stringify({ event_type: "embodied-daily", client_payload: { source: "vercel-cron" } })
  });
  if (response.status !== 204) {
    const raw = await response.text();
    console.error("[cron]", response.status, raw.slice(0, 500));
    return res.status(502).json({ ok: false, error: `GitHub dispatch failed: HTTP ${response.status}` });
  }
  return res.status(200).json({ ok: true, dispatched: true });
}
