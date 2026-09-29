import fs from "node:fs/promises";
import path from "node:path";

const CARRYOVERS = JSON.parse(await fs.readFile("config/carryovers.json", "utf8"));
const BANNED_HOSTS = ["sina.com", "sina.com.cn", "sina.cn", "163.com"];

function targetWindow(date) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) throw new Error("Invalid target date");
  const end = Date.parse(`${date.replaceAll(".", "-")}T09:00:00+08:00`);
  if (!Number.isFinite(end)) throw new Error("Invalid target date");
  return { start: end - 86_400_000, end };
}

function shanghaiTime(millis) {
  return new Date(millis + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
}

function parsedTime(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value)) {
    throw new Error(`${label} must be an exact Asia/Shanghai timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`Invalid ${label}`);
  return millis;
}

function clean(value, label, min, max) {
  if (typeof value !== "string") throw new Error(`Missing ${label}`);
  const text = value.trim();
  const length = [...text].length;
  if (length < min || length > max) throw new Error(`${label} must be ${min}-${max} characters`);
  return text;
}

function directUrl(value) {
  const url = new URL(clean(value, "url", 12, 1200));
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
    throw new Error("Source must be a public HTTPS URL");
  }
  const host = url.hostname.toLowerCase();
  if (BANNED_HOSTS.some(d => host === d || host.endsWith(`.${d}`))) {
    throw new Error("Banned final-source domain");
  }
  url.hash = "";
  return url.toString();
}

function normalize(value) {
  return String(value).normalize("NFKC").replace(/&nbsp;|&#160;/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, "").toLowerCase();
}

async function verifyEvidence(url, quote) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EmbodiedDailySourceCheck/1.0)" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Source did not open: HTTP ${response.status} ${url}`);
  const contentType = response.headers.get("content-type") || "";
  if (!/html|text/i.test(contentType)) throw new Error("New-item source must expose readable article text");
  const body = await response.text();
  if (!normalize(body).includes(normalize(quote))) {
    throw new Error(`Evidence quote not found in source: ${url}`);
  }
}

function assertNotCarryover(item, date) {
  if (date !== "2026.09.30") return;
  const value = `${item.title} ${item.summary}`.toLowerCase();
  if ((value.includes("智元") && value.includes("爱仕达")) || value.includes("sharpa") || value.includes("本末科技")) {
    throw new Error("A carryover was repeated as a new item");
  }
}

export async function buildDaily(date, raw, { verifyLinks = true } = {}) {
  const { start, end } = targetWindow(date);
  const max = date === "2026.09.30" ? 6 : 5;
  const carryovers = CARRYOVERS[date] || [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Copilot output must be raw JSON"); }
  if (!Array.isArray(parsed.new_items)) throw new Error("Missing new_items array");
  if (parsed.new_items.length > max - carryovers.length) throw new Error("Too many new items");

  const items = [...carryovers];
  const seenKeys = new Set();
  const seenUrls = new Set(carryovers.map(item => directUrl(item.url)));
  for (const candidate of parsed.new_items) {
    const eventKey = clean(candidate.event_key, "event_key", 6, 120).toLowerCase();
    if (seenKeys.has(eventKey)) throw new Error("Duplicate event_key");
    seenKeys.add(eventKey);
    const item = {
      title: clean(candidate.title, "title", 8, 80),
      summary: clean(candidate.summary, "summary", 100, 220),
      source: clean(candidate.source, "source", 2, 80),
      url: directUrl(candidate.url)
    };
    if (seenUrls.has(item.url)) throw new Error("Duplicate source URL");
    seenUrls.add(item.url);
    assertNotCarryover(item, date);
    for (const [label, value] of [
      ["published_at", candidate.published_at],
      ["first_disclosed_at", candidate.first_disclosed_at]
    ]) {
      const millis = parsedTime(value, label);
      if (millis < start || millis >= end) throw new Error(`${label} falls outside the daily window`);
    }
    const quote = clean(candidate.evidence_quote, "evidence_quote", 10, 180);
    if (verifyLinks) await verifyEvidence(item.url, quote);
    items.push(item);
  }
  if (items.length < 3 || items.length > max) throw new Error(`Expected 3-${max} qualified items`);
  const text = [
    `具身智能每日推｜${date}`,
    "",
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      item.summary,
      `来源：${item.source}`,
      item.url,
      ""
    ])
  ].join("\n").trim() + "\n";
  if (text.length > 12000) throw new Error("Payload exceeds relay limit");
  return text;
}

async function main() {
  const [mode, date, filename] = process.argv.slice(2);
  if (mode === "prompt") {
    const { start, end } = targetWindow(date);
    const carryovers = CARRYOVERS[date] || [];
    const template = await fs.readFile("prompts/cloud-daily.md", "utf8");
    const prompt = template
      .replaceAll("{{DATE}}", date)
      .replaceAll("{{WINDOW_START}}", shanghaiTime(start))
      .replaceAll("{{WINDOW_END}}", shanghaiTime(end))
      .replaceAll("{{CARRYOVER_COUNT}}", String(carryovers.length))
      .replaceAll("{{NEW_LIMIT}}", String((date === "2026.09.30" ? 6 : 5) - carryovers.length))
      .replaceAll("{{CARRYOVER_NOTE}}", carryovers.length
        ? "Three previously verified items are stored locally and will be merged by code. Do not repeat 智元灵犀X2/爱仕达100店, Sharpa IROS D01/W02/AE01, or 本末科技港股配发."
        : "There are no carryover items today.");
    await fs.writeFile(filename, prompt);
    return;
  }
  if (mode === "build") {
    const raw = await fs.readFile(filename, "utf8");
    const text = await buildDaily(date, raw);
    await fs.mkdir("queue", { recursive: true });
    await fs.writeFile(path.join("queue", `${date}.txt`), text);
    return;
  }
  throw new Error("Usage: node scripts/cloud-daily.mjs prompt|build YYYY.MM.DD filename");
}

if (process.argv[1]?.endsWith("cloud-daily.mjs")) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
