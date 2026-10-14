import fs from "node:fs/promises";
import path from "node:path";
import { readPage, plainText, pageTitle } from "./http.mjs";
import { targetWindow, WINDOW_HOURS } from "./window.mjs";
import { loadHistory } from "./history.mjs";
import { normTitle } from "./collect.mjs";
import { sourceError, publishedSourceError, isAllowedSourceUrl, payloadSourceError, SOURCES, accountPublisher } from "../lib/source-policy.js";
import { excludedEventReason, topicLimitError, countTopics } from "../lib/editorial-policy.js";

export const MAX_ITEMS = 6;
export const TARGET_MIN = 3;
export const EMPTY_NOTICE = `过去 ${WINDOW_HOURS} 小时内没有达到筛选标准的内容，本期不推送条目。`;
export const SHORT_NOTICE = "本期合格内容不足 3 条，未用旧闻或弱相关内容补足。";

const BANNED_HOSTS = ["sina.com", "sina.com.cn", "sina.cn", "163.com"];

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
    .replace(/cite[^]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function checkItem(candidate, window, fetchPage, seen, history) {
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
  const channelError = sourceError(item.source, item.url)
    || payloadSourceError(`1. 【${item.tag}】${item.title}\n${item.summary}\n来源：${item.source}\n${item.url}\n`);
  if (channelError) throw new Error(channelError);
  const eventKey = text(candidate.event_key, "event_key", 3, 120).toLowerCase();
  if (seen.keys.has(eventKey) || seen.urls.has(item.url)) throw new Error("与已入选条目重复");
  const old = history.find(h => h.url === item.url || (normTitle(h.title) && normTitle(h.title) === normTitle(item.title)));
  if (old) throw new Error(`与 ${old.date} 已推送内容重复`);

  for (const [label, value] of [["发布时间", candidate.published_at], ["首次披露时间", candidate.first_disclosed_at]]) {
    const millis = exactTime(value, label);
    if (millis < window.start || millis >= window.end) throw new Error(`${label} ${value} 不在窗口内`);
  }
  const evidence = text(candidate.evidence_quote, "事实摘录", 10, 180);

  const page = await fetchPage(item.url);
  if (!page.ok) throw new Error(`链接打不开：HTTP ${page.status}`);
  const publisherError = publishedSourceError(item.source, item.url, page);
  if (publisherError) throw new Error(publisherError);
  const pageCopy = plainText(page.body);
  const body = normalize(pageCopy);
  if (!body.includes(normalize(evidence))) throw new Error("页面里找不到事实摘录");
  const raw = normalize(page.body);
  if (!dateForms(candidate.published_at).some(form => raw.includes(normalize(form)))) {
    throw new Error("页面上找不到与发布时间一致的日期");
  }

  const reports = [];
  for (const link of [...new Set(candidate.independent_reports || [])].slice(0, 6)) {
    let other;
    try { other = hostOf(link); } catch { continue; }
    if (other === host || !isAllowedSourceUrl(link) || reports.some(r => r.host === other)) continue;
    const res = await fetchPage(link);
    const publisher = SOURCES.find(s => onList(other, s.domains))?.name || accountPublisher(res.body, res.url || link);
    if (res.ok && publisher && !publishedSourceError(publisher, link, res)) reports.push({ host: other, url: link });
  }
  seen.keys.add(eventKey);
  seen.urls.add(item.url);
  return { ...item, page_title: pageTitle(page.body).slice(0, 120),
    heat: { independent_reports: reports, note: String(candidate.heat_note || "").slice(0, 200) } };
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

// Coverage gaps are reported, never used to block the send.
export function coverageIssues(model) {
  return (model.coverage || [])
    .filter(row => row.status === "unavailable" || (row.list_status === "unreachable" && !row.queries?.length)
      || (row.list_status === "kr36_account" && !row.relevant && !row.queries?.length))
    .map(row => `${row.source}：${row.status === "unavailable" ? "列表读取失败且未检索" : "未留下检索记录"}`);
}

export async function buildDaily(date, model, { fetchPage = readPage, history = [] } = {}) {
  const window = targetWindow(date);
  if (!model || !Array.isArray(model.items)) throw new Error("模型输出缺少 items");
  const kept = [];
  const dropped = [];
  const topics = new Map();
  const seen = { keys: new Set(), urls: new Set() };
  for (const candidate of model.items) {
    if (kept.length >= MAX_ITEMS) { dropped.push({ title: candidate?.title, url: candidate?.url, reason: "超过 6 条上限" }); continue; }
    try {
      const exclusion = excludedEventReason(candidate);
      if (exclusion) throw new Error(exclusion);
      const item = await checkItem(candidate, window, fetchPage, seen, history);
      const limitError = topicLimitError(item, topics);
      if (limitError) throw new Error(limitError);
      countTopics(item, topics);
      kept.push(item);
    }
    catch (error) { dropped.push({ title: candidate?.title, url: candidate?.url, reason: error.message }); }
  }
  const payload = formatPayload(date, kept);
  if (payload.length > 12000) throw new Error("推送文本超过中继长度上限");
  return { payload, kept, dropped, coverage_issues: coverageIssues(model) };
}

export function renderReport(date, collected, model, result) {
  const cell = v => String(v ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
  const out = [`# 具身智能每日推运行报告 ${date}`, ""];
  out.push(`窗口：${collected?.window?.start} 至 ${collected?.window?.end}`, "");
  out.push(`入选 ${result.kept.length} 条；代码剔除 ${result.dropped.length} 条。`);
  if (result.coverage_issues.length) out.push(`覆盖缺口（不阻止发送）：${result.coverage_issues.join("；")}`);
  const m = model?.meta;
  if (m) {
    out.push(`模型：${m.model}；联网搜索 ${m.searches} 次；补查新增候选 ${m.swept_added} 篇；核查事件 ${m.events} 个，通过 ${m.verified_included} 个；参考前 3 期 ${m.history} 条。`);
    out.push("", "| 步骤 | 用时（秒） | 搜索次数 |", "| --- | --- | --- |");
    for (const s of m.stages || []) out.push(`| ${cell(s.stage)} | ${cell(s.seconds)} | ${cell(s.searches)} |`);
  }
  out.push("", "## 来源覆盖", "", "| 来源 | 列表状态 | 列表篇数 | 窗口内相关 | 结论 | 说明 |", "| --- | --- | --- | --- | --- | --- |");
  for (const row of model?.coverage || []) {
    out.push(`| ${cell(row.source)} | ${cell(row.list_status)} | ${cell(row.listed)} | ${cell(row.relevant)} | ${cell(row.status)} | ${cell(row.note)} |`);
  }
  out.push("", "## 入选与热度", "");
  for (const item of result.kept) {
    out.push(`- 【${item.tag}】${item.title}（${item.source}）：独立报道 ${item.heat.independent_reports.length} 家。${item.heat.note}`);
  }
  if (model?.editorial_decisions?.length) {
    out.push("", "## 重要性与标签取舍", "");
    for (const d of model.editorial_decisions) out.push(`- ${cell(d.title)}：${d.keep ? "主编保留" : "主编剔除"}；${cell(d.reason)}`);
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
  const history = await loadHistory(date);
  const result = await buildDaily(date, model, { history });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "payload.txt"), result.payload);
  await fs.writeFile(path.join(outDir, "report.md"), renderReport(date, collected, model, result));
  await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(`kept=${result.kept.length} dropped=${result.dropped.length} coverage_issues=${result.coverage_issues.length}`);
}

if (process.argv[1]?.endsWith("cloud-daily.mjs")) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
