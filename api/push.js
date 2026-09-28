const REQUIRED_SOURCES = [
  "机器之心/机器之心Pro",
  "新智元",
  "量子位",
  "AI前线/InfoQ",
  "极客公园",
  "36氪/硬氪",
  "投资界",
  "甲子光年",
  "晚点",
  "硅星人",
  "你好太空"
];

const BANNED_HOSTS = [
  "sina.com",
  "sina.com.cn",
  "sina.cn",
  "163.com"
];

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_ITEMS = 5;
const MIN_ITEMS = 3;

function nowInSingapore() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

function dateInSingapore() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${map.year}.${map.month}.${map.day}`;
}

function outputText(resp) {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }
  const parts = [];
  for (const item of resp?.output || []) {
    for (const c of item?.content || []) {
      if (c?.type === "output_text" && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function isBannedHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return BANNED_HOSTS.some(d => h === d || h.endsWith("." + d));
}

function cleanText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(m[1]).slice(0, 300) : "";
}

async function fetchWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EmbodiedAIDailyBot/2.0)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyUrl(item) {
  let u;
  try {
    u = new URL(item.url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    return { ok: false, reason: "invalid_protocol" };
  }
  if (isBannedHost(u.hostname)) {
    return { ok: false, reason: "banned_host" };
  }

  try {
    const response = await fetchWithTimeout(u.toString());
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }
    const finalUrl = response.url || u.toString();
    const finalHost = new URL(finalUrl).hostname;
    if (isBannedHost(finalHost)) {
      return { ok: false, reason: "redirected_to_banned_host" };
    }

    const type = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) {
      return { ok: false, reason: "non_text_page" };
    }

    const html = await response.text();
    const body = cleanText(html);
    const pageTitle = htmlTitle(html);

    if (body.length < 300) {
      return { ok: false, reason: "page_too_thin" };
    }

    return {
      ok: true,
      final_url: finalUrl,
      page_title: pageTitle,
      excerpt: body.slice(0, 6000)
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "fetch_failed"
    };
  }
}

async function callOpenAI(body, timeoutMs = 100000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": crypto.randomUUID()
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}: ${data?.error?.message || "request_failed"}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function generationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["date", "checked_sources", "items"],
    properties: {
      date: { type: "string" },
      checked_sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "status"],
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["checked_no_item", "checked_has_candidate"] }
          }
        }
      },
      items: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "summary", "source", "source_title", "published_at", "url"],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            source: { type: "string" },
            source_title: { type: "string" },
            published_at: { type: "string" },
            url: { type: "string" }
          }
        }
      }
    }
  };
}

function verificationSchema(count) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["checks"],
    properties: {
      checks: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "ok", "reason"],
          properties: {
            index: { type: "integer" },
            ok: { type: "boolean" },
            reason: { type: "string" }
          }
        }
      }
    }
  };
}

function buildResearchPrompt() {
  return `
你正在制作“具身智能每日推”。当前新加坡/北京时间：${nowInSingapore()}。

这不是新闻汇总。必须先逐源核查以下全部渠道过去24小时内容，再做补充搜索：
${REQUIRED_SOURCES.map((x, i) => `${i + 1}. ${x}`).join("\n")}

只保留3–5条真正需要当天知道的消息：
A）被多方同时讨论、热度明显高；
B）刚刚爆出，虽尚未广泛扩散，但可能影响技术路线、商业判断或产业预期。

编辑要求：
- 核心看具身智能、人形机器人、机器人操作，以及真正影响它们的通用大模型/Agent变化。
- 优先关注：通用模型与具身模型关系、机器人数据路线、真实商业化/收入/复购/ROI、触觉与末端执行、世界模型与机器人训练、资本市场重新定价。
- 可选择性加入商业航天、物流、船舶/航运，但只有当天出现非常强的行业消息才加入，不要求覆盖所有方向。
- 不收论文、学术论文解读、普通新品、一般融资、常规官宣、低讨论度Demo。
- 模型新闻优先采用机器之心、新智元、量子位、AI前线/InfoQ、极客公园、36氪/硬氪等已约定专业媒体，不强制官方首发。
- 商业航天国内创业公司/融资优先硬氪等专业媒体。
- 物流优先专业行业媒体或一手运营/客户数据，不使用泛财经媒体凑数。
- 严禁使用新浪、网易（包括任何 sina.* / 163.com）作为最终来源或最终链接。
- 同一事件有约定专业媒体或原始来源时，不得使用弱转载站、聚合页、搜索页、频道页。
- 海外重大公司/资本市场事件可以用Reuters等一线国际机构或公司官方原始来源。
- 最终URL必须是具体正文落地页；必须实际打开页面确认标题和正文支持该条消息。
- 每条summary约100–220个中文字，只传递消息，不写“为什么值得看”、趋势判断、建议或策略。
- 不使用【跨界】【核心】【重点】【高热】【突发】等标签。
- source_title必须填写最终URL页面对应文章的原始标题，不能填写你自己改写的标题。
- published_at填写页面显示的发布日期/时间，至少精确到日期。

checked_sources必须覆盖上面11个渠道，每个渠道只标记：
checked_no_item 或 checked_has_candidate。
不能声称检查但实际没有搜索/打开。

日期字段必须是今天：${dateInSingapore()}。
`;
}

async function generateBrief() {
  const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
  const response = await callOpenAI({
    model,
    store: false,
    reasoning: { effort: "high" },
    tools: [{ type: "web_search", search_context_size: "high" }],
    input: buildResearchPrompt(),
    text: {
      format: {
        type: "json_schema",
        name: "embodied_ai_daily",
        strict: true,
        schema: generationSchema()
      }
    }
  });

  const text = outputText(response);
  if (!text) throw new Error("OpenAI returned empty output");
  const brief = JSON.parse(text);

  const checked = new Set((brief.checked_sources || []).map(x => x.name));
  const missing = REQUIRED_SOURCES.filter(x => !checked.has(x));
  if (missing.length) {
    throw new Error(`Source audit incomplete: ${missing.join(", ")}`);
  }
  if (brief.date !== dateInSingapore()) {
    throw new Error(`Wrong date: ${brief.date}`);
  }
  if (!Array.isArray(brief.items) || brief.items.length < MIN_ITEMS || brief.items.length > MAX_ITEMS) {
    throw new Error("Item count out of range");
  }
  return brief;
}

async function verifySemantics(items, pageEvidence) {
  const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
  const evidence = items.map((item, index) => ({
    index,
    candidate: item,
    fetched_page_title: pageEvidence[index].page_title,
    fetched_final_url: pageEvidence[index].final_url,
    fetched_excerpt: pageEvidence[index].excerpt
  }));

  const response = await callOpenAI({
    model,
    store: false,
    reasoning: { effort: "medium" },
    input: `
你是发送前的链接核验器。逐条判断候选消息是否被实际抓取到的最终网页直接支持。

严格规则：
- 页面标题/正文必须与候选消息是同一事件，不允许“语义相近但不是同一篇/同一事件”。
- summary中的关键数字、主体、动作必须能在页面中找到支持。
- source_title应与页面原始标题一致或明显是同一标题的轻微格式差异。
- 如果页面只是频道页、列表页、搜索页、聚合页，标记false。
- 任何不确定都标记false。

证据：
${JSON.stringify(evidence)}
`,
    text: {
      format: {
        type: "json_schema",
        name: "link_verification",
        strict: true,
        schema: verificationSchema(items.length)
      }
    }
  });

  const text = outputText(response);
  if (!text) throw new Error("Verification returned empty output");
  return JSON.parse(text).checks;
}

function buildDigestText(brief) {
  const lines = [`具身智能每日推｜${brief.date}`, ""];
  brief.items.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.title}`);
    lines.push(item.summary.trim());
    lines.push(`来源：${item.source}`);
    lines.push(item.url);
    if (idx < brief.items.length - 1) lines.push("");
  });
  return lines.join("\n");
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
        { tag: "div", text: { tag: "lark_md", content: text } }
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

function authorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  const manualSecret = process.env.MANUAL_SECRET;
  const auth = req.headers.authorization;

  if (cronSecret && auth === `Bearer ${cronSecret}`) return "cron";
  if (manualSecret && req.headers["x-manual-secret"] === manualSecret) return "manual";
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (process.env.AUTO_PUSH_DISABLED === "1") {
    return res.status(503).json({ ok: false, error: "Automatic push is disabled" });
  }

  const actor = authorized(req);
  if (!actor) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ ok: false, error: "OPENAI_API_KEY is not configured" });
  }
  if (!process.env.FEISHU_WEBHOOK_URL) {
    return res.status(503).json({ ok: false, error: "FEISHU_WEBHOOK_URL is not configured" });
  }

  const dryRun = req.query?.dry === "1" || req.query?.dry === "true";

  try {
    const brief = await generateBrief();

    const pageEvidence = [];
    for (const item of brief.items) {
      const result = await verifyUrl(item);
      if (!result.ok) {
        throw new Error(`URL verification failed for "${item.title}": ${result.reason}`);
      }
      item.url = result.final_url;
      pageEvidence.push(result);
    }

    const semanticChecks = await verifySemantics(brief.items, pageEvidence);
    const failedChecks = semanticChecks.filter(x => !x.ok);
    if (failedChecks.length) {
      throw new Error(`Semantic verification failed: ${failedChecks.map(x => `#${x.index + 1} ${x.reason}`).join("; ")}`);
    }

    const payload = buildDigestText(brief);

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dry_run: true,
        actor,
        date: brief.date,
        payload,
        checked_sources: brief.checked_sources,
        semantic_checks: semanticChecks
      });
    }

    const feishu = await sendToFeishu(payload);
    return res.status(200).json({
      ok: true,
      sent: true,
      actor,
      date: brief.date,
      item_count: brief.items.length,
      feishu
    });
  } catch (error) {
    console.error("[daily-push]", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
