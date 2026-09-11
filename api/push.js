import crypto from "node:crypto";

const PROMPT = `
你正在制作一份“具身智能每日推”，面向长期关注具身智能、机器人、Physical AI 的行业从业者。

时间范围：
- 以当前北京时间为截止点，重点检索过去24小时；
- 如果某条消息发生于48小时内，但今天仍被多个专业渠道持续讨论，可以保留；
- 不要为了凑数量加入普通新闻。

只保留两类：
A. 被多方同时讨论、圈内热度明显较高的话题；
B. 刚刚爆出、虽尚未广泛扩散，但可能影响技术路线、商业化、资本预期或行业认知的重要消息。

优先方向：
- GPT/VLM 与具身模型、VLA、World Model 的关系
- 机器人数据：集中式数采、真实场景数据、遥操作、仿真、世界模型
- 灵巧手、触觉、末端执行器
- 人形/移动操作本体的关键技术变化
- 物流仓储、工业真实落地
- 收入、订单、复购、ROI、IPO、融资与资本市场变化
- 头部公司/创始人/研究者具有讨论度的公开发言
- 可少量加入当天明显破圈、会影响 Physical AI 上游预期的 AI 基础模型/算力消息

信息源优先级：
机器之心 / 机器之心Pro、新智元、量子位、AI前线/InfoQ、极客公园、36氪/硬氪、投资界、
甲子光年、晚点、硅星人、你好太空，以及公司创始人/核心高管原始演讲、采访、官方技术博客、视频号/B站。
同一事件如已有上述专业来源，优先引用专业来源或原始发言。
小红书、行业自媒体、泛财经媒体、转载站可以用于发现线索和判断热度，但在有更专业来源时不要作为主来源。

输出边界：
- 只做“消息总结概述 + 来源 + 链接”；
- 不解释为什么值得看；
- 不写我的判断、趋势总结、最终建议、最值得继续追；
- 尽量不使用“未证实/可信度”等判断标签，只有不说明就会造成事实误导时才极简说明；
- 不写长背景科普；
- 每条摘要约80–180个中文字；
- 每条至少给1个可直接打开、真实存在的来源URL；
- 优先4–6条，宁少勿滥。

只输出合法 JSON，不要输出 Markdown 代码块，不要输出 JSON 以外的任何文字：
{
  "date": "YYYY.MM.DD",
  "items": [
    {
      "title": "简短消息标题",
      "summary": "消息概述",
      "source": "来源名称",
      "url": "https://..."
    }
  ]
}
`;

function beijingNow() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function outputText(resp) {
  if (typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }
  const parts = [];
  for (const item of resp.output || []) {
    for (const c of item.content || []) {
      if (c.type === "output_text" && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function parseJson(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

function feishuSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

function buildCard(brief) {
  const elements = [];
  brief.items.forEach((item, idx) => {
    const safeTitle = String(item.title || "").trim();
    const safeSummary = String(item.summary || "").trim();
    const safeSource = String(item.source || "").trim();
    const safeUrl = String(item.url || "").trim();

    const sourceLine = safeUrl
      ? `来源：[${safeSource || "原文"}](${safeUrl})`
      : `来源：${safeSource || "—"}`;

    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${idx + 1}｜${safeTitle}**\n${safeSummary}\n${sourceLine}`,
      },
    });

    if (idx < brief.items.length - 1) elements.push({ tag: "hr" });
  });

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: "plain_text",
          content: `具身智能每日推｜${brief.date}`,
        },
        template: "blue",
      },
      elements,
    },
  };
}

async function generateBrief() {
  const input = `${PROMPT}\n当前北京时间：${beijingNow()}。现在联网检索并生成今天这一期。`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.6-terra",
      tools: [{ type: "web_search" }],
      input,
    }),
  });

  const raw = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}: ${raw?.error?.message || JSON.stringify(raw)}`);
  }

  const text = outputText(raw);
  if (!text) throw new Error("OpenAI returned empty output");

  const brief = parseJson(text);
  if (!brief?.date || !Array.isArray(brief?.items) || brief.items.length === 0) {
    throw new Error("Generated brief does not match expected structure");
  }

  brief.items = brief.items.slice(0, 6);
  return brief;
}

async function sendToFeishu(brief) {
  if (!process.env.FEISHU_WEBHOOK_URL) {
    throw new Error("FEISHU_WEBHOOK_URL is not configured");
  }

  const body = buildCard(brief);

  if (process.env.FEISHU_BOT_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = feishuSign(timestamp, process.env.FEISHU_BOT_SECRET);
  }

  const response = await fetch(process.env.FEISHU_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });

  const resultText = await response.text();
  let result;
  try {
    result = JSON.parse(resultText);
  } catch {
    result = { raw: resultText };
  }

  if (!response.ok || (result.code != null && result.code !== 0) || (result.StatusCode != null && result.StatusCode !== 0)) {
    throw new Error(`Feishu webhook failed: HTTP ${response.status} ${resultText}`);
  }

  return result;
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

function manualAuthorized(req) {
  const manualSecret = process.env.MANUAL_SECRET;
  if (!manualSecret) return false;
  return req.headers["x-manual-secret"] === manualSecret;
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!cronAuthorized(req) && !manualAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
  }

  const dryRun = req.query?.dry === "1" || req.query?.dry === "true";

  try {
    const brief = await generateBrief();

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dry_run: true,
        brief,
        generated_at_beijing: beijingNow(),
      });
    }

    const feishu = await sendToFeishu(brief);
    return res.status(200).json({
      ok: true,
      brief,
      feishu,
      generated_at_beijing: beijingNow(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
