import { createRemoteJWKSet, jwtVerify } from "jose";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "feishu-embodied-ai-daily-relay";
const GITHUB_REPOSITORY = "Kiera007-ui/feishu-embodied-ai-daily";
// events: allowed to call the relay; live: allowed to send for real.
const GITHUB_WORKFLOW_REFS = {
  "Kiera007-ui/feishu-embodied-ai-daily/.github/workflows/daily-feishu.yml@refs/heads/main": {
    events: ["push"], live: ["push"]
  },
  "Kiera007-ui/feishu-embodied-ai-daily/.github/workflows/cloud-daily.yml@refs/heads/main": {
    events: ["schedule", "workflow_dispatch", "repository_dispatch", "push"],
    live: ["schedule", "workflow_dispatch", "repository_dispatch"]
  }
};
const githubJwks = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks")
);

const MAX_TEXT_LENGTH = 12000;
const MAX_ITEMS = 6;
const EMPTY_NOTICE = "没有达到筛选标准";
const BANNED_HOSTS = ["sina.com", "sina.com.cn", "sina.cn", "163.com"];

function singaporeDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${map.year}.${map.month}.${map.day}`;
}

function containsBannedUrl(text) {
  const urls = String(text || "").match(/https?:\/\/[^\s)\]>]+/gi) || [];
  return urls.some(raw => {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return BANNED_HOSTS.some(d => host === d || host.endsWith("." + d));
    } catch {
      return true;
    }
  });
}

export function validatePayload(text, requestedDate) {
  if (!text) return "Message text is required";
  if (text.length > MAX_TEXT_LENGTH) return "Message is too long";
  if (!/^具身智能每日推｜\d{4}\.\d{2}\.\d{2}/.test(text)) {
    return "Invalid daily-push header";
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  const payloadDate = firstLine.replace("具身智能每日推｜", "").trim();
  if (payloadDate !== requestedDate) return "Payload date does not match request date";

  const itemLines = text.split(/\r?\n/).filter(line => /^\d+\.\s+/.test(line));
  if (itemLines.length > MAX_ITEMS) return `Daily push must contain at most ${MAX_ITEMS} numbered items`;
  if (itemLines.length === 0 && !text.includes(EMPTY_NOTICE)) {
    return "An empty daily push must state that nothing met the criteria";
  }
  if (itemLines.some(line => !/^\d+\.\s+【[\p{Script=Han}]{2,6}】\S/u.test(line))) {
    return "Each numbered item must start with one Chinese topic tag";
  }

  if (containsBannedUrl(text)) {
    return "Payload contains a banned final-link domain";
  }
  return null;
}

async function authorizeGithub(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return null;

  try {
    const { payload } = await jwtVerify(auth.slice(7), githubJwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: GITHUB_OIDC_AUDIENCE
    });

    if (payload.repository !== GITHUB_REPOSITORY) return null;
    if (payload.ref !== "refs/heads/main") return null;
    const eventName = String(payload.event_name || "");
    const policy = GITHUB_WORKFLOW_REFS[String(payload.workflow_ref)];
    if (!policy?.events.includes(eventName)) return null;

    return {
      repository: String(payload.repository),
      sha: String(payload.sha || ""),
      runId: String(payload.run_id || ""),
      eventName,
      mayGoLive: policy.live.includes(eventName)
    };
  } catch (error) {
    console.error("[relay-auth]", error);
    return null;
  }
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

async function sendToFeishu(text) {
  const response = await fetch(process.env.FEISHU_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(buildFeishuCard(text))
  });

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }

  const failed =
    !response.ok ||
    (data?.code != null && data.code !== 0) ||
    (data?.StatusCode != null && data.StatusCode !== 0);

  if (failed) {
    throw new Error(`Feishu webhook failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  }
  return data;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const identity = await authorizeGithub(req);
  if (!identity) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!process.env.FEISHU_WEBHOOK_URL) {
    return res.status(503).json({ ok: false, error: "FEISHU_WEBHOOK_URL is not configured" });
  }

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const date = typeof req.body?.date === "string" ? req.body.date.trim() : "";
  const dryRun = req.query?.dry === "1" || req.query?.dry === "true";

  if (!identity.mayGoLive && !dryRun) {
    return res.status(403).json({ ok: false, error: `${identity.eventName} runs must be dry-run` });
  }

  const validationError = validatePayload(text, date);
  if (validationError) {
    return res.status(400).json({ ok: false, error: validationError });
  }

  if (!dryRun && date !== singaporeDate()) {
    return res.status(409).json({
      ok: false,
      error: `Live send date ${date} is not today ${singaporeDate()}`
    });
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      date,
      item_count: (text.match(/^\d+\.\s+/gm) || []).length,
      authenticated_repository: identity.repository
    });
  }

  try {
    const feishu = await sendToFeishu(text);
    return res.status(200).json({
      ok: true,
      sent: true,
      date,
      item_count: (text.match(/^\d+\.\s+/gm) || []).length,
      feishu
    });
  } catch (error) {
    console.error("[relay]", error);
    return res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
