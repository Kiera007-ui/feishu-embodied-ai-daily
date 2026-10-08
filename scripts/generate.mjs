import fs from "node:fs/promises";
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

async function call(method, url, body, { timeout = 120_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    }).catch(error => ({ ok: false, status: 0, text: async () => String(error) }));
    const raw = await response.text();
    if (response.ok) return JSON.parse(raw);
    const retryable = response.status === 0 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 4) {
      const error = new Error(`OpenAI API ${method} failed: HTTP ${response.status} ${raw.slice(0, 600)}`);
      error.status = response.status;
      throw error;
    }
    await new Promise(r => setTimeout(r, attempt * 15_000));
  }
}

function outputText(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  return (response.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(part => part.type === "output_text")
    .map(part => part.text)
    .join("");
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
  try {
    response = await call("POST", API, { ...request, background: true, store: true });
  } catch (error) {
    // Some gateways do not support background mode; fall back to one long request.
    if (error.status !== 400 && error.status !== 404 && error.status !== 422) throw error;
    console.warn("Background mode was rejected; retrying as a single request.");
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
  const parsed = JSON.parse(outputText(response));
  return { ...parsed, meta: { response_id: response.id, model: response.model, searches, usage: response.usage } };
}

if (process.argv[1]?.endsWith("generate.mjs")) {
  const [date, input, output] = process.argv.slice(2);
  fs.readFile(input, "utf8")
    .then(raw => generate(date, JSON.parse(raw)))
    .then(result => fs.writeFile(output, JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
