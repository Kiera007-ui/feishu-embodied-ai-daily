import fs from "node:fs/promises";
import { fetchText, postJson, postForm, decodeEntities, plainText, readPage } from "./http.mjs";
import { targetWindow, shanghaiTime } from "./window.mjs";

// Topics the daily covers. Matching only narrows the candidate list; the
// model still reads each article and decides relevance.
export const TOPIC = new RegExp([
  "机器人", "具身", "人形", "四足", "机器狗", "灵巧手", "机械臂", "协作臂", "关节模组", "执行器", "减速器", "丝杠",
  "触觉", "世界模型", "VLA", "物理AI", "物理 AI", "Physical AI",
  "水下", "深海", "海洋装备", "无人船", "航天", "火箭", "卫星", "太空", "低空", "无人机", "eVTOL", "飞行汽车",
  "仓储", "物流自动化", "AGV", "AMR", "Robotaxi", "自动驾驶", "无人配送",
  "robot", "humanoid", "embodied", "quadruped", "dexterous", "manipulat", "actuator", "world model",
  "drone", "rocket", "satellite", "spacecraft", "underwater", "subsea", "autonomous"
].join("|"), "i");

// Media the daily must cover. All of them except 新智元 have a readable article
// list; 新智元 is read from its 36Kr account and searched by the model.
export const REQUIRED_SOURCES = ["36氪/硬氪", "量子位", "机器之心", "新智元", "晚点LatePost", "极客公园", "投资界", "AI前线/InfoQ", "甲子光年"];
export const SEARCH_SOURCES = ["新智元"];
// No readable web edition was found outside Sina/NetEase. They are used when a
// readable page turns up, but missing them is not a coverage gap.
export const OPTIONAL_SOURCES = ["硅星人", "你好太空"];

// 36Kr carries synced articles from other media under the media's own account.
const KR36_ACCOUNTS = [
  [/量子位/, "量子位"], [/机器之心/, "机器之心"], [/新智元/, "新智元"], [/晚点/, "晚点LatePost"],
  [/极客公园/, "极客公园"], [/投资界/, "投资界"], [/AI前线|InfoQ/i, "AI前线/InfoQ"], [/甲子光年/, "甲子光年"],
  [/硅星人/, "硅星人"], [/你好太空/, "你好太空"]
];
export function groupFor36krAuthor(author) {
  for (const [pattern, group] of KR36_ACCOUNTS) if (pattern.test(String(author || ""))) return group;
  return "36氪/硬氪";
}

const KR36_GATEWAY = "https://gateway.36kr.com/api/mis/nav";
// web_news is 36Kr's full article stream; AI repeats the AI channel so a busy
// day cannot push robotics stories past the paging limit.
const KR36_STREAMS = [
  { label: "36氪", path: "/ifm/subNav/flow", param: { subnavType: 1, subnavNick: "web_news" }, maxPages: 30 },
  { label: "36氪", path: "/ifm/subNav/flow", param: { subnavType: 1, subnavNick: "AI" }, maxPages: 8 },
  { label: "36氪快讯", path: "/newsflash/flow", param: {}, maxPages: 20 }
];

const RSS_SOURCES = [
  { name: "量子位", url: "https://www.qbitai.com/feed" },
  { name: "AI前线/InfoQ", url: "https://www.infoq.cn/feed" },
  { name: "极客公园", url: "https://www.geekpark.net/rss" },
  { name: "TechCrunch Robotics", url: "https://techcrunch.com/category/robotics/feed/" },
  { name: "IEEE Spectrum Robotics", url: "https://spectrum.ieee.org/feeds/topic/robotics.rss" }
];

const pad = n => String(n).padStart(2, "0");

export function normTitle(value) {
  return String(value || "").normalize("NFKC")
    .replace(/[｜|丨].{0,12}(?:首发|独家|36氪|硬氪).*$/u, "")
    .replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

async function kr36Items(earliest) {
  const out = [];
  let failures = 0;
  for (const stream of KR36_STREAMS) {
    let callback = "";
    for (let page = 0; page < stream.maxPages; page += 1) {
      const data = await postJson(KR36_GATEWAY + stream.path, {
        partner_id: "web", timestamp: Date.now(),
        param: { ...stream.param, pageSize: 50, pageEvent: page === 0 ? 0 : 1, pageCallback: callback, siteId: 1, platformId: 2 }
      });
      const list = data?.data?.itemList;
      if (!Array.isArray(list)) { failures += 1; break; }
      for (const entry of list) {
        const m = entry.templateMaterial || {};
        if (!m.widgetTitle || !m.publishTime) continue;
        const flash = stream.label === "36氪快讯";
        const author = String(m.authorName || "").trim();
        const group = flash ? "36氪/硬氪" : groupFor36krAuthor(author);
        out.push({
          source: group === "36氪/硬氪" ? stream.label : group, group, author,
          synced_on_36kr: group !== "36氪/硬氪",
          title: decodeEntities(m.widgetTitle), summary: decodeEntities(m.summary || ""),
          url: `https://www.36kr.com/${flash ? "newsflashes" : "p"}/${m.itemId || entry.itemId}`,
          published_at: shanghaiTime(Number(m.publishTime))
        });
      }
      const oldest = Math.min(...list.map(x => Number(x.templateMaterial?.publishTime)).filter(Number.isFinite));
      callback = data.data.pageCallback;
      if (!callback || !data.data.hasNextPage || oldest < earliest) break;
    }
  }
  return { items: out, failures };
}

function rssItems(xml, name) {
  return String(xml).split(/<item[\s>]/).slice(1).map(block => {
    const pick = tag => decodeEntities(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || "").trim();
    const time = Date.parse(pick("pubDate"));
    return {
      source: name, group: name, title: pick("title"),
      summary: pick("description").replace(/<[^>]*>/g, " ").slice(0, 300),
      url: pick("link").replace(/^http:/, "https:").replace(/[?&]utm_[^&]+/g, ""),
      published_at: Number.isFinite(time) ? shanghaiTime(time) : null
    };
  });
}

function pedailyItems(html) {
  const out = [];
  const re = /<h3><a href="(https:\/\/news\.pedaily\.cn\/\d+\/\d+\.shtml)"[^>]*>([^<]+)<\/a><\/h3>[\s\S]{0,900}?<span class="date">(\d{4}-\d{2}-\d{2} \d{2}:\d{2})<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ source: "投资界", group: "投资界", title: decodeEntities(m[2]).trim(), url: m[1], published_at: `${m[3].replace(" ", "T")}:00+08:00` });
  }
  return out;
}

async function jazzyearItems() {
  const home = await fetchText("https://www.jazzyear.com/");
  if (!home.ok) throw new Error(`HTTP ${home.status}`);
  const views = new Map();
  for (const m of home.body.matchAll(/article_info\.html\?id=(\d+)">([^<]+)<\/a>[\s\S]{0,200}?<i>(\d+)<\/i>/g)) views.set(m[1], Number(m[3]));
  const ids = [...new Set([...home.body.matchAll(/article_info\.html\?id=(\d+)/g)].map(m => m[1]))]
    .sort((a, b) => Number(b) - Number(a)).slice(0, 10);
  const out = [];
  for (const id of ids) {
    const url = `https://www.jazzyear.com/article_info.html?id=${id}`;
    const page = await fetchText(url);
    if (!page.ok) continue;
    const title = decodeEntities(page.body.match(/<title>([^<]*)/)?.[1] || "").trim();
    const date = page.body.match(/(20\d\d-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
    out.push({
      source: "甲子光年", group: "甲子光年", title, url,
      published_at: date ? `${date[1]}T${date[2] || "12:00"}:00+08:00` : null,
      time_precision: date?.[2] ? "minute" : "date",
      engagement: views.has(id) ? { views: views.get(id) } : undefined
    });
  }
  return out;
}

export function jiqizhixinTime(value) {
  const m = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:00+08:00` : null;
}

async function jiqizhixinItems(earliest) {
  const out = [];
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetchText(`https://www.jiqizhixin.com/api/article_library/articles.json?sort=time&page=${page}&per=20`);
    if (!res.ok) { if (page === 1) throw new Error(`HTTP ${res.status}`); break; }
    let list;
    try { list = JSON.parse(res.body).articles || []; } catch { throw new Error("文章列表不是 JSON"); }
    for (const a of list) {
      if (!a.slug || !a.title) continue;
      out.push({
        source: "机器之心", group: "机器之心", title: a.title, author: a.author,
        summary: plainText(a.content || "").slice(0, 300),
        url: `https://www.jiqizhixin.com/articles/${a.slug}`, published_at: jiqizhixinTime(a.publishedAt)
      });
    }
    const times = list.map(a => Date.parse(jiqizhixinTime(a.publishedAt) || "")).filter(Number.isFinite);
    if (!times.length || Math.min(...times) < earliest) break;
  }
  return out;
}

// LatePost shows "10月10日" on its list and "10月10日 14:10" on the article page.
export function latepostTime(text, now = Date.now()) {
  const m = String(text || "").match(/(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const today = new Date(now + 8 * 3600_000);
  let year = today.getUTCFullYear();
  if (Number(m[1]) > today.getUTCMonth() + 2) year -= 1;
  const clock = m[3] ? `${pad(m[3])}:${m[4]}` : "12:00";
  return `${year}-${pad(m[1])}-${pad(m[2])}T${clock}:00+08:00`;
}

async function latepostItems(earliest) {
  const out = [];
  for (let page = 1; page <= 2; page += 1) {
    const res = await postForm("https://www.latepost.com/news/get-news-data", { page, limit: 20 });
    const list = Array.isArray(res?.data) ? res.data : [];
    if (!list.length) { if (page === 1) throw new Error("文章列表为空"); break; }
    for (const a of list) {
      if (!a.detail_url || !a.title) continue;
      out.push({
        source: "晚点LatePost", group: "晚点LatePost", title: decodeEntities(a.title),
        summary: decodeEntities(a.abstract || a.intro || "").slice(0, 300),
        url: new URL(a.detail_url, "https://www.latepost.com").href,
        published_at: latepostTime(a.release_time), time_precision: "date"
      });
    }
    const times = out.map(x => Date.parse(x.published_at || "")).filter(Number.isFinite);
    if (!times.length || Math.min(...times) < earliest) break;
  }
  // Read the exact minute from each recent article page.
  for (const item of out) {
    const time = Date.parse(item.published_at || "");
    if (!Number.isFinite(time) || time < earliest - 86_400_000) continue;
    const page = await fetchText(item.url);
    const exact = page.ok ? latepostTime(page.body.match(/\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/)?.[0]) : null;
    if (exact) { item.published_at = exact; item.time_precision = "minute"; }
  }
  return out;
}

async function kr36Engagement(url) {
  if (!url.includes("36kr.com/p/")) return undefined;
  const page = await fetchText(url);
  if (!page.ok) return undefined;
  const num = key => Number(page.body.match(new RegExp(`"${key}":(\\d+)`))?.[1] ?? NaN);
  const value = { likes: num("likeCount"), favorites: num("favoriteCount"), comments: num("statComment") };
  return Object.values(value).some(Number.isFinite) ? value : undefined;
}

export async function readCandidate(item) {
  const page = await readPage(item.url);
  if (!page.ok) { item.read_status = "HTTP " + page.status; return; }
  const body = plainText(page.body);
  if (body.length < 200) { item.read_status = "正文过短"; return; }
  item.article_text = body.slice(0, 9000);
  item.article_text_truncated = body.length > 9000;
  item.read_status = "readable";
  item.engagement ??= await kr36Engagement(item.url);
}

// A media article synced to 36Kr should be linked on the media's own site.
// When the same title is on both, keep the media's own page.
export function preferOwnSite(items) {
  const own = new Map();
  for (const item of items) if (!item.synced_on_36kr) own.set(`${item.group}|${normTitle(item.title)}`, item);
  const out = [];
  for (const item of items) {
    if (item.synced_on_36kr) {
      const match = own.get(`${item.group}|${normTitle(item.title)}`);
      if (match) { (match.mirror_urls ||= []).push(item.url); continue; }
    }
    out.push(item);
  }
  return out;
}

export async function collect(date) {
  const { start, end } = targetWindow(date);
  // Keep some history so the model can recognise reposts of older events.
  const earliest = start - 12 * 3600_000;
  const coverage = [];
  const all = [];
  const record = (source, status, found, note = "") => coverage.push({ source, status, found, note });

  const { items: krItems, failures: krFailures } = await kr36Items(earliest);
  all.push(...krItems);
  record("36氪/硬氪", krItems.length ? "listed" : "unreachable", krItems.length, krFailures ? `${krFailures} 个分页读取失败` : "");

  for (const feed of RSS_SOURCES) {
    const page = await fetchText(feed.url);
    if (!page.ok) { record(feed.name, "unreachable", 0, `HTTP ${page.status}`); continue; }
    const items = rssItems(page.body, feed.name);
    all.push(...items);
    record(feed.name, "listed", items.length);
  }

  const lists = [
    ["投资界", async () => { const ped = await fetchText("https://news.pedaily.cn/"); if (!ped.ok) throw new Error(`HTTP ${ped.status}`); return pedailyItems(ped.body); }],
    ["甲子光年", jazzyearItems],
    ["机器之心", () => jiqizhixinItems(earliest)],
    ["晚点LatePost", () => latepostItems(earliest)]
  ];
  for (const [name, load] of lists) {
    try { const items = await load(); all.push(...items); record(name, "listed", items.length); }
    catch (error) { record(name, "unreachable", 0, String(error.message || error)); }
  }
  const synced = name => krItems.filter(item => item.group === name).length;
  record("新智元", "kr36_account", synced("新智元"), "无官网文章列表；读取其 36氪账号同步文章，并由模型定向搜索");
  for (const name of OPTIONAL_SOURCES) record(name, "optional", synced(name), "未找到新浪/网易以外的固定网页列表；有可读网页时可用");

  const seen = new Set();
  const candidates = [];
  for (const item of preferOwnSite(all)) {
    if (!item.title || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const time = Date.parse(item.published_at || "");
    if (!Number.isFinite(time) || time < earliest || time >= end + 3 * 3600_000) continue;
    // Article teasers may name the application while the headline only names a company.
    if (!TOPIC.test(item.title + " " + (item.summary || ""))) continue;
    candidates.push({ ...item, origin: "list", in_window: time >= start && time < end });
  }
  const toRead = candidates.filter(item => item.in_window);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, toRead.length) }, async () => {
    while (next < toRead.length) await readCandidate(toRead[next++]);
  }));
  candidates.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  for (const row of coverage) {
    const matches = toRead.filter(c => c.group === row.source);
    row.relevant = matches.length;
    row.readable = matches.filter(c => c.read_status === "readable").length;
  }

  return { date, window: { start: shanghaiTime(start), end: shanghaiTime(end) }, coverage, candidates };
}

if (process.argv[1]?.endsWith("collect.mjs")) {
  const [date, output] = process.argv.slice(2);
  collect(date)
    .then(result => fs.writeFile(output, JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
