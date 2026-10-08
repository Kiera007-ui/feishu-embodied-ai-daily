import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { targetWindow, shanghaiTime } from "./window.mjs";

// OPENAI_BASE_URL lets the pipeline use an OpenAI-compatible gateway.
const API = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
const BANNED_SEARCH_DOMAINS = ["sina.com.cn", "sina.cn", "sina.com", "163.com"];

const str = { type: "string" };
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "rejected", "watchlist", "coverage"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_key", "tag", "title", "summary", "source", "url", "published_at", "first_disclosed_at",
          "evidence_quote", "analysis_quote", "independent_reports", "heat_note"],
        properties: {
          event_key: str, tag: str, title: str, summary: str, source: str, url: str,
          published_at: str, first_disclosed_at: str, evidence_quote: str, analysis_quote: str,
          independent_reports: { type: "array", items: str }, heat_note: str
        }
      }
    },
    rejected: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "url", "reason"], properties: { title: str, url: str, reason: str } }
    },
    watchlist: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "reason", "url"], properties: { name: str, reason: str, url: str } }
    },
    coverage: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["source", "status", "note"],
        properties: { source: str, status: { type: "string", enum: ["found", "checked_none", "unavailable"] }, note: str }
      }
    }
  }
};

export async function buildPrompt(date, collected) {
  const { start, end } = targetWindow(date);
  const template = await fs.readFile(new URL("../prompts/cloud-daily.md", import.meta.url), "utf8");
  const candidates = collected.candidates.map(c => ({
    title: c.title, source: c.source, url: c.url, published_at: c.published_at,
    in_window: c.in_window, engagement: c.engagement
  }));
  return template
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{WINDOW_START}}", shanghaiTime(start))
    .replaceAll("{{WINDOW_END}}", shanghaiTime(end))
    .replaceAll("{{CANDIDATES}}", JSON.stringify(candidates, null, 1));
}

// Node's fetch gives up when response headers take more than 5 minutes, and a
// model run with web search can take longer. node:https has no such limit.
function request(method, url, body, timeout) {
  return new Promise(resolve => {
    const target = new URL(url);
    const data = body ? JSON.stringify(body) : undefined;
    const req = (target.protocol === "http:" ? http : https).request(target, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        const status = res.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", error => { clearTimeout(timer); resolve({ ok: false, status: 0, text: String(error) }); });
    });
    const timer = setTimeout(() => req.destroy(new Error(`no complete response within ${timeout / 1000}s`)), timeout);
    req.on("error", error => { clearTimeout(timer); resolve({ ok: false, status: 0, text: String(error) }); });
    req.setNoDelay(true);
    req.setSocketKeepAlive?.(true, 60_000);
    if (data) req.write(data);
    req.end();
  });
}

async function call(method, url, body, { timeout = 120_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const response = await request(method, url, body, timeout);
    const raw = response.text;
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`[model] ${method} attempt ${attempt}: HTTP ${response.status} after ${seconds}s`);
    if (response.ok) return JSON.parse(raw);
    // A request that ran for minutes before failing was real work; retrying it
    // would push the job past its time limit, so only quick failures retry.
    const quick = seconds < 300;
    // Gateways report a failed upstream account as HTTP 400 bad_response_status_code.
    const upstream = response.status === 400 && /bad_response_status_code|upstream/i.test(raw);
    const retryable = quick && (response.status === 0 || response.status === 429 || response.status >= 500 || upstream);
    if (!retryable || attempt >= 7) {
      const error = new Error(`OpenAI API ${method} failed: HTTP ${response.status} ${raw.slice(0, 600)}`);
      error.status = response.status;
      throw error;
    }
    console.log(`[model] retrying: ${raw.slice(0, 200).replace(/\s+/g, " ")}`);
    // Gateways that pool accounts return 429 for short periods; back off longer.
    await new Promise(r => setTimeout(r, attempt * 30_000));
  }
}

function tryParse(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const attempts = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start > 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && Array.isArray(value.items) && Array.isArray(value.coverage)) return value;
    } catch {}
  }
  return null;
}

// Some gateways return progress notes as separate messages before the JSON
// (or join them into output_text), so look for the message that is the JSON.
export function parseModelOutput(response) {
  const messages = (response.output || [])
    .filter(item => item.type === "message")
    .map(item => (item.content || []).filter(part => part.type === "output_text").map(part => part.text).join(""));
  for (const text of [...messages].reverse()) {
    const value = tryParse(text);
    if (value) return value;
  }
  const value = tryParse(response.output_text) || tryParse(messages.join(""));
  if (value) return value;
  const preview = (messages.at(-1) || response.output_text || "").slice(0, 300);
  throw new Error(`Model output has no valid daily JSON. Last message starts: ${preview}`);
}

export async function generate(date, collected) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const input = await buildPrompt(date, collected);
  const request = {
    model: process.env.OPENAI_MODEL || "gpt-6.1-sol",
    reasoning: { effort: process.env.OPENAI_REASONING || "high" },
    tools: [{ type: "web_search", filters: { blocked_domains: BANNED_SEARCH_DOMAINS } }],
    include: ["web_search_call.action.sources"],
    text: { format: { type: "json_schema", name: "embodied_daily", strict: true, schema: OUTPUT_SCHEMA } },
    input
  };
  let response;
  if (process.env.OPENAI_BACKGROUND === "true") {
    response = await call("POST", API, { ...request, background: true, store: true });
  } else {
    // One long request works with OpenAI and with compatible gateways.
    response = await call("POST", API, request, { timeout: 30 * 60_000 });
  }
  const deadline = Date.now() + 40 * 60_000;
  while (["queued", "in_progress"].includes(response.status)) {
    if (Date.now() > deadline) throw new Error("OpenAI response did not finish within 40 minutes");
    await new Promise(r => setTimeout(r, 15_000));
    response = await call("GET", `${API}/${response.id}`);
  }
  if (response.status !== "completed") {
    throw new Error(`OpenAI response ended as ${response.status}: ${JSON.stringify(response.error || response.incomplete_details)}`);
  }
  const searches = (response.output || []).filter(item => item.type === "web_search_call").length;
  const parsed = parseModelOutput(response);
  await fixLengths(parsed, request.model);
  return { ...parsed, meta: { response_id: response.id, model: response.model, searches, usage: response.usage } };
}

const chars = value => [...String(value || "").trim()].length;
export const LIMITS = { title: [8, 60], summary: [100, 220] };
export const needsFix = item =>
  Object.entries(LIMITS).some(([key, [min, max]]) => chars(item[key]) < min || chars(item[key]) > max);

// The checker drops items whose title or summary is outside the length limits.
// Rewriting only the wording is cheaper than losing an otherwise good item.
export async function fixLengths(result, model) {
  const targets = (result.items || []).map((item, index) => ({ index, item })).filter(({ item }) => needsFix(item));
  if (!targets.length) return;
  const input = [
    "下面是日推条目的标题和摘要，长度不符合要求。逐条改写：",
    "- title：8–50 个字符，陈述核心事实。",
    "- summary：120–200 个字符（中文、英文字母、数字、标点和空格都按 1 个字符计）。",
    "只压缩或调整措辞，保留原有事实、关键数字和来源中的第三方判断，不增加任何新信息。",
    "只输出 JSON。",
    JSON.stringify(targets.map(({ index, item }) => ({ index, title: item.title, summary: item.summary })), null, 1)
  ].join("\n");
  const schema = {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["index", "title", "summary"],
      properties: { index: { type: "integer" }, title: str, summary: str }
    } } }
  };
  try {
    const response = await call("POST", API, {
      model, reasoning: { effort: "low" }, input,
      text: { format: { type: "json_schema", name: "length_fix", strict: true, schema } }
    }, { timeout: 5 * 60_000 });
    const texts = (response.output || []).filter(item => item.type === "message")
      .map(item => (item.content || []).filter(part => part.type === "output_text").map(part => part.text).join(""));
    let fixed = null;
    for (const text of [...texts, response.output_text].reverse()) {
      const raw = String(text || "");
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      try { fixed = JSON.parse(raw.slice(start, end + 1)); break; } catch {}
    }
    for (const entry of fixed?.items || []) {
      const item = result.items[entry.index];
      if (!item) continue;
      const candidate = { ...item, title: entry.title, summary: entry.summary };
      if (!needsFix(candidate)) Object.assign(item, { title: entry.title, summary: entry.summary });
    }
    console.log(`[model] length fix: ${targets.length} items needed it, ${targets.filter(({ item }) => !needsFix(item)).length} fixed`);
  } catch (error) {
    console.log(`[model] length fix failed: ${error.message.slice(0, 200)}`);
  }
}

if (process.argv[1]?.endsWith("generate.mjs")) {
  const [date, input, output] = process.argv.slice(2);
  fs.readFile(input, "utf8")
    .then(raw => generate(date, JSON.parse(raw)))
    .then(result => fs.writeFile(output, JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
