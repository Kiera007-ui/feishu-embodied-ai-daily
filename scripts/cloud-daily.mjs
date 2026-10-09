import fs from "node:fs/promises";
import path from "node:path";
import { fetchText, plainText, pageTitle } from "./http.mjs";
import { targetWindow } from "./window.mjs";
import { REQUIRED_SOURCES, SEARCH_ONLY_SOURCES } from "./collect.mjs";

export const MAX_ITEMS = 6;
export const TARGET_MIN = 3;
export const EMPTY_NOTICE = "过去 24 小时内没有达到筛选标准的内容，本期不推送条目。";
export const SHORT_NOTICE = "本期合格内容不足 3 条，未用旧闻或弱相关内容补足。";

const BANNED_HOSTS = ["sina.com", "sina.com.cn", "sina.cn", "163.com"];
const PRESS_RELEASE_HOSTS = ["prnewswire.com", "businesswire.com", "globenewswire.com", "accesswire.com",
  "einpresswire.com", "newswire.ca", "prweb.com", "newsfilecorp.com"];
const FIRST_HAND_TITLE = /首发|独家|exclusive/i;
const FIRST_HAND_REHOST = /(?:近日|此前).{0,20}(?:硬氪|36氪).{0,10}(?:消息称|获悉|报道)/i;
const FIRST_HAND_REHOST_AGAIN = /(?:综合|来源).{0,30}(?:硬氪|36氪)/i;

const hostOf = url => new URL(url).hostname.toLowerCase().replace(/^www\./, "");
const onList = (host, list) => list.some(d => host === d || host.endsWith(`.${d}`));

function normalize(value) {
  return String(value).normalize("NFKC").replace(/[\s"'“”‘’「」『』]/g, "").toLowerCase();
}

function dateForms(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  const mi = Number(m), di = Number(d);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const long = months[mi - 1];
  return [`${y}-${m}-${d}`, `${y}/${m}/${d}`, `${y}.${m}.${d}`, `${y}年${m}月${d}日`, `${y}年${mi}月${di}日`,
    `${y}/${mi}/${di}`, `${y}-${mi}-${di}`, `${long} ${di}, ${y}`, `${long.slice(0, 3)} ${di}, ${y}`, `${di} ${long} ${y}`,
    `${long.slice(0, 3)}. ${di}, ${y}`, `${mi}月${di}日`];
}

function exactTime(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value)) {
    throw new Error(`${label} 不是精确的北京时间`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} 无效`);
  return millis;
}

function text(value, label, min, max) {
  const out = typeof value === "string" ? value.trim() : "";
  const length = [...out].length;
  if (length < min || length > max) throw new Error(`${label} 长度应为 ${min}-${max}，实际 ${length}`);
  return out;
}

export function cleanCopy(value) {
  return String(value || "")
    .replace(/\(\[([^\]]+)\]\(https?:\/\/[^)]+\)\)/g, "")
    .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, "")
    .replace(/【(?:\d+|[a-z0-9_-]+)†[^】]*】/gi, "")
    .replace(/cite[^]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const SOURCE_ALIASES = {
  "36氪/硬氪": ["36氪", "硬氪", "36kr"],
  "AI前线/InfoQ": ["AI前线", "InfoQ"],
  "机器之心/机器之心Pro": ["机器之心", "jiqizhixin"],
  "晚点LatePost": ["晚点", "LatePost"],
  "硅星人": ["硅星人", "硅星"],
  "你好太空": ["你好太空"],
};

async function auditCoverage(model, collected, fetchPage) {
  const issues = [];
  const actualQueries = model.meta?.search_queries || [];
  for (const source of REQUIRED_SOURCES) {
    const rows = (model.coverage || []).filter(row => row.source === source);
    if (rows.length !== 1) { issues.push(source + "：缺少唯一的逐源核查记录"); continue; }
    const row = rows[0];
    if (row.status === "unavailable") { issues.push(source + "：来源不可核查"); continue; }
    const collectedRow = collected?.coverage?.find(entry => entry.source === source);
    if (collectedRow?.relevant > 0 && row.status !== "found") {
      issues.push(source + "：候选不为空，但未记录候选核读");
    }
    const needsSearch = SEARCH_ONLY_SOURCES.includes(source) || collectedRow?.status === "unreachable" || !collectedRow?.relevant;
    if (needsSearch) {
      const aliases = SOURCE_ALIASES[source] || [source];
      const searched = actualQueries.filter(query => aliases.some(alias => query.toLowerCase().includes(alias.toLowerCase())));
      if (searched.length < 2) issues.push(source + "：搜索工具记录少于两次定向检索");
    }
    const urls = [...new Set(row.checked_urls || [])].slice(0, 3);
    if (!urls.length && row.status === "found") { issues.push(source + "：有候选但没有可核读网页"); continue; }
    if (collectedRow?.relevant > 0 && !urls.some(url => collected.candidates?.some(candidate =>
      candidate.in_window && candidate.group === source && candidate.url === url))) {
      issues.push(source + "：未核读列表中的窗口内候选");
    }
    let opened = false;
    for (const url of urls) {
      try {
        if (!/^https?:$/.test(new URL(url).protocol)) continue;
        const page = await fetchPage(url);
        if (page.ok && plainText(page.body).length > 100) opened = true;
      } catch {}
    }
    if (urls.length && !opened) issues.push(source + "：列出的网页无法读取");
  }
  return issues;
}

async function checkItem(candidate, window, fetchPage, seen) {
  const tag = text(candidate.tag, "标签", 2, 6);
  if (!/^[\p{Script=Han}]{2,6}$/u.test(tag)) throw new Error("标签必须是 2–6 个汉字");
  const item = {
    tag,
    title: text(candidate.title, "标题", 8, 60),
    summary: text(cleanCopy(candidate.summary), "摘要", 100, 220),
    source: text(candidate.source, "来源", 2, 40),
    url: text(candidate.url, "链接", 12, 1200)
  };
  const url = new URL(item.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("链接不是网页地址");
  const host = hostOf(item.url);
  if (onList(host, BANNED_HOSTS) || /新浪|网易/.test(item.source)) throw new Error("来源是新浪或网易");
  if (onList(host, PRESS_RELEASE_HOSTS)) throw new Error("来源是通稿发布平台");
  const eventKey = text(candidate.event_key, "event_key", 3, 120).toLowerCase();
  if (seen.keys.has(eventKey) || seen.urls.has(item.url)) throw new Error("与已入选条目重复");

  for (const [label, value] of [["发布时间", candidate.published_at], ["首次披露时间", candidate.first_disclosed_at]]) {
    const millis = exactTime(value, label);
    if (millis < window.start || millis >= window.end) throw new Error(`${label} ${value} 不在窗口内`);
  }
  const evidence = text(candidate.evidence_quote, "事实摘录", 10, 180);
  const analysis = text(candidate.analysis_quote, "评述摘录", 10, 220);
  if (normalize(evidence) === normalize(analysis)) throw new Error("评述摘录与事实摘录相同");

  const page = await fetchPage(item.url);
  if (!page.ok) throw new Error(`链接打不开：HTTP ${page.status}`);
  const title = pageTitle(page.body);
  if (FIRST_HAND_TITLE.test(title)) throw new Error(`来源是首发/独家报道：${title.slice(0, 60)}`);
  const pageCopy = plainText(page.body);
  if (FIRST_HAND_REHOST.test(pageCopy) && FIRST_HAND_REHOST_AGAIN.test(pageCopy)) {
    throw new Error("来源主要转述首发报道，缺少可核实的独立增量");
  }
  const body = normalize(pageCopy);
  if (!body.includes(normalize(evidence))) throw new Error("页面里找不到事实摘录");
  if (!body.includes(normalize(analysis))) throw new Error("页面里找不到评述摘录");
  const raw = normalize(page.body);
  if (!dateForms(candidate.published_at).some(form => raw.includes(normalize(form)))) {
    throw new Error("页面上找不到与发布时间一致的日期");
  }

  const reports = [];
  for (const link of [...new Set(candidate.independent_reports || [])].slice(0, 6)) {
    let other;
    try { other = hostOf(link); } catch { continue; }
    if (other === host || onList(other, BANNED_HOSTS) || reports.some(r => r.host === other)) continue;
    const res = await fetchPage(link);
    if (res.ok) reports.push({ host: other, url: link });
  }
  seen.keys.add(eventKey);
  seen.urls.add(item.url);
  return { ...item, heat: { independent_reports: reports, note: String(candidate.heat_note || "").slice(0, 200) } };
}

export function formatPayload(date, items) {
  const lines = [`具身智能每日推｜${date}`, ""];
  if (!items.length) return `${lines.join("\n")}${EMPTY_NOTICE}\n`;
  items.forEach((item, index) => {
    lines.push(`${index + 1}. 【${item.tag}】${item.title}`, item.summary, `来源：${item.source}`, item.url, "");
  });
  if (items.length < TARGET_MIN) lines.push(SHORT_NOTICE, "");
  return lines.join("\n").trim() + "\n";
}

export async function buildDaily(date, model, { fetchPage = url => fetchText(url), collected = null } = {}) {
  const window = targetWindow(date);
  if (!model || !Array.isArray(model.items)) throw new Error("模型输出缺少 items");
  const kept = [];
  const dropped = [];
  const seen = { keys: new Set(), urls: new Set() };
  const coverage_issues = await auditCoverage(model, collected, fetchPage);
  for (const candidate of model.items) {
    if (kept.length >= MAX_ITEMS) { dropped.push({ title: candidate?.title, url: candidate?.url, reason: "超过 6 条上限" }); continue; }
    try { kept.push(await checkItem(candidate, window, fetchPage, seen)); }
    catch (error) { dropped.push({ title: candidate?.title, url: candidate?.url, reason: error.message }); }
  }
  const payload = formatPayload(date, kept);
  if (payload.length > 12000) throw new Error("推送文本超过中继长度上限");
  return { payload, kept, dropped, coverage_issues };
}

export function renderReport(date, collected, model, result) {
  const cell = v => String(v ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
  const out = [`# 具身智能每日推运行报告 ${date}`, ""];
  out.push(`窗口：${collected?.window?.start} 至 ${collected?.window?.end}`, "");
  out.push(`入选 ${result.kept.length} 条；代码剔除 ${result.dropped.length} 条。`);
  if (result.coverage_issues.length) out.push(`逐源核查缺口：${result.coverage_issues.join("；")}`);
  if (model?.meta) out.push(`模型：${model.meta.model}；联网搜索 ${model.meta.searches} 次；response ${model.meta.response_id}`);
  out.push("", "## 来源覆盖", "", "| 来源 | 程序采集 | 窗口内相关 | 模型检索 | 说明 |", "| --- | --- | --- | --- | --- |");
  const modelCoverage = new Map((model?.coverage || []).map(c => [c.source, c]));
  for (const row of collected?.coverage || []) {
    const m = [...modelCoverage.entries()].find(([k]) => k.includes(row.source.split("/")[0]) || row.source.includes(k));
    out.push(`| ${cell(row.source)} | ${cell(row.status === "search_only" ? "无列表" : row.found)} | ${cell(row.relevant)} | ${cell(m?.[1]?.status)} | ${cell([row.note, m?.[1]?.note].filter(Boolean).join("；"))} |`);
  }
  out.push("", "## 入选与热度", "");
  for (const item of result.kept) {
    out.push(`- 【${item.tag}】${item.title}（${item.source}）：独立报道 ${item.heat.independent_reports.length} 家。${item.heat.note}`);
  }
  if (result.dropped.length) {
    out.push("", "## 代码剔除", "");
    for (const d of result.dropped) out.push(`- ${cell(d.title)}：${cell(d.reason)} ${cell(d.url)}`);
  }
  if (model?.rejected?.length) {
    out.push("", "## 模型未选", "");
    for (const r of model.rejected) out.push(`- ${cell(r.title)}：${cell(r.reason)} ${cell(r.url)}`);
  }
  if (model?.watchlist?.length) {
    out.push("", "## 待跟进", "");
    for (const w of model.watchlist) out.push(`- ${cell(w.name)}：${cell(w.reason)} ${cell(w.url)}`);
  }
  return out.join("\n") + "\n";
}

async function main() {
  const [mode, date, collectedFile, modelFile, outDir] = process.argv.slice(2);
  if (mode !== "build") throw new Error("Usage: node scripts/cloud-daily.mjs build YYYY.MM.DD collected.json model.json outDir");
  const collected = JSON.parse(await fs.readFile(collectedFile, "utf8"));
  const model = JSON.parse(await fs.readFile(modelFile, "utf8"));
  const result = await buildDaily(date, model, { collected });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "payload.txt"), result.payload);
  await fs.writeFile(path.join(outDir, "report.md"), renderReport(date, collected, model, result));
  await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(`kept=${result.kept.length} dropped=${result.dropped.length}`);
}

if (process.argv[1]?.endsWith("cloud-daily.mjs")) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
