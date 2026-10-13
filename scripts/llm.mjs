import http from "node:http";
import https from "node:https";
import { SEARCH_DOMAINS } from "../lib/source-policy.js";

// OPENAI_BASE_URL lets the pipeline use an OpenAI-compatible gateway.
export const API = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
export const searchTool = () => ({ type: "web_search", filters: { allowed_domains: [...SEARCH_DOMAINS] } });
export const model = () => process.env.OPENAI_MODEL || "gpt-6.1-sol";

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

export async function call(method, url, body, { timeout = 120_000, label = "model", maxAttempts = 6 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const response = await request(method, url, body, timeout);
    const raw = response.text;
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`[${label}] ${method} attempt ${attempt}: HTTP ${response.status} after ${seconds}s`);
    if (response.ok) return JSON.parse(raw);
    // A request that ran for minutes before failing was real work; retrying it
    // would push the job past its time limit, so only quick failures retry.
    // Gateways report a failed upstream account as HTTP 400 bad_response_status_code.
    const upstream = response.status === 400 && /bad_response_status_code|upstream/i.test(raw);
    const quick = seconds < 300;
    const transient = response.status === 0 || response.status === 429 || response.status >= 500 || upstream;
    // A slow upstream failure is retried once; quick ones up to maxAttempts.
    const retryable = transient && (quick || attempt === 1);
    if (!retryable || attempt >= maxAttempts) {
      const error = new Error(`OpenAI API ${method} failed: HTTP ${response.status} ${raw.slice(0, 600)}`);
      error.status = response.status;
      throw error;
    }
    console.log(`[${label}] retrying: ${raw.slice(0, 200).replace(/\s+/g, " ")}`);
    await new Promise(r => setTimeout(r, attempt * 20_000));
  }
}

function tryParse(text, accept) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const attempts = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start > 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === "object" && accept(value)) return value;
    } catch {}
  }
  return null;
}

// Some gateways return progress notes as separate messages before the JSON
// (or join them into output_text), so look for the message that is the JSON.
export function extractJson(response, accept = () => true) {
  const messages = (response.output || [])
    .filter(item => item.type === "message")
    .map(item => (item.content || []).filter(part => part.type === "output_text").map(part => part.text).join(""));
  for (const text of [...messages].reverse()) {
    const value = tryParse(text, accept);
    if (value) return value;
  }
  const value = tryParse(response.output_text, accept) || tryParse(messages.join(""), accept);
  if (value) return value;
  const preview = (messages.at(-1) || response.output_text || "").slice(0, 300);
  throw new Error(`Model output has no valid JSON. Last message starts: ${preview}`);
}

export function searchQueries(response) {
  return (response.output || []).filter(item => item.type === "web_search_call")
    .flatMap(item => item.action?.queries || (item.action?.query ? [item.action.query] : []))
    .filter(query => typeof query === "string");
}

export async function runModel({ name, input, schema, effort = "medium", search = false, timeout = 20 * 60_000 }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const body = {
    model: model(), reasoning: { effort }, input,
    text: { format: { type: "json_schema", name, strict: true, schema } }
  };
  if (search) {
    body.tools = [searchTool()];
    body.include = ["web_search_call.action.sources"];
  }
  const started = Date.now();
  let response = await call("POST", API, body, { timeout, label: name });
  while (["queued", "in_progress"].includes(response.status)) {
    if (Date.now() - started > timeout) throw new Error(`${name} did not finish in time`);
    await new Promise(r => setTimeout(r, 15_000));
    response = await call("GET", `${API}/${response.id}`, undefined, { label: name });
  }
  if (response.status && response.status !== "completed") {
    throw new Error(`${name} ended as ${response.status}: ${JSON.stringify(response.error || response.incomplete_details)}`);
  }
  const queries = searchQueries(response);
  return {
    value: extractJson(response),
    meta: { stage: name, response_id: response.id, model: response.model, searches: queries.length, queries,
      seconds: Math.round((Date.now() - started) / 1000), usage: response.usage }
  };
}
