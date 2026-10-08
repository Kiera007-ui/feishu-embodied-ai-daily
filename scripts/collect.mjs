import fs from "node:fs/promises";
import { fetchText, postJson, decodeEntities } from "./http.mjs";
import { targetWindow, shanghaiTime } from "./window.mjs";

// Topics the daily covers. Matching only narrows the candidate list; the
// model still reads each article and decides relevance.
export const TOPIC = new RegExp([
  "机器人", "具身", "人形", "四足", "机器狗", "灵巧手", "机械臂", "协作臂", "关节模组", "执行器", "减速器", "丝杠",
  "触觉", "世界模型", "VLA", "物理AI", "物理 AI", "Physical AI",
  "水下", "深海", "海洋装备", "无人船", "航天", "火箭", "卫星", "太空", "低空", "无人机", "eVTOL", "飞行汽车",
  "仓储", "物流自动化", "AGV", "AMR", "Robotaxi", "自动驾驶",
  "robot", "humanoid", "embodied", "quadruped", "dexterous", "manipulat", "actuator", "world model",
  "drone", "rocket", "satellite", "spacecraft", "underwater", "subsea", "autonomous"
].join("|"), "i");

const KR36_GATEWAY = "https://gateway.36kr.com/api/mis/nav";
// web_news is 36Kr's full article stream; AI repeats the AI channel so a busy
// day cannot push robotics stories past the paging limit.
const KR36_STREAMS = [
  { label: "36氪", path: "/ifm/subNav/flow", param: { subnavType: 1, subnavNick: "web_news" }, maxPages: 25 },
  { label: "36氪", path: "/ifm/subNav/flow", param: { subnavType: 1, subnavNick: "AI" }, maxPages: 6 },
  { label: "36氪快讯", path: "/newsflash/flow", param: {}, maxPages: 15 }
];

const RSS_SOURCES = [
  { name: "量子位", url: "https://www.qbitai.com/feed" },
  { name: "AI前线/InfoQ", url: "https://www.infoq.cn/feed" },
  { name: "极客公园", url: "https://www.geekpark.net/rss" },
  { name: "TechCrunch Robotics", url: "https://techcrunch.com/category/robotics/feed/" },
  { name: "IEEE Spectrum Robotics", url: "https://spectrum.ieee.org/feeds/topic/robotics.rss" }
];

// Sources without a readable list page. The model searches them directly.
export const SEARCH_ONLY_SOURCES = ["机器之心/机器之心Pro", "新智元", "晚点LatePost", "硅星人", "你好太空"];

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
        out.push({
          source: stream.label, group: "36氪/硬氪", title: decodeEntities(m.widgetTitle),
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
      source: name,
      group: name,
      title: pick("title"),
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
    .sort((a, b) => Number(b) - Number(a)).slice(0, 8);
  const out = [];
  for (const id of ids) {
    const url = `https://www.jazzyear.com/article_info.html?id=${id}`;
    const page = await fetchText(url);
    if (!page.ok) continue;
    const title = decodeEntities(page.body.match(/<title>([^<]*)/)?.[1] || "").trim();
    const date = page.body.match(/(20\d\d-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
    out.push({
      source: "甲子光年", group: "甲子光年", title, url,
      published_at: date ? `${date[1]}T${date[2] || "00:00"}:00+08:00` : null,
      time_precision: date?.[2] ? "minute" : "date",
      engagement: views.has(id) ? { views: views.get(id) } : undefined
    });
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

export async function collect(date) {
  const { start, end } = targetWindow(date);
  // Keep a little history so the model can recognise reposts of older events.
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

  const ped = await fetchText("https://news.pedaily.cn/");
  if (ped.ok) { const items = pedailyItems(ped.body); all.push(...items); record("投资界", "listed", items.length); }
  else record("投资界", "unreachable", 0, `HTTP ${ped.status}`);

  try { const items = await jazzyearItems(); all.push(...items); record("甲子光年", "listed", items.length); }
  catch (error) { record("甲子光年", "unreachable", 0, String(error.message || error)); }

  for (const name of SEARCH_ONLY_SOURCES) record(name, "search_only", 0, "无可读取的文章列表，由模型定向搜索");

  const seen = new Set();
  const candidates = [];
  for (const item of all) {
    if (!item.title || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const time = Date.parse(item.published_at || "");
    if (!Number.isFinite(time) || time < earliest || time >= end + 3 * 3600_000) continue;
    if (!TOPIC.test(item.title)) continue;
    candidates.push({ ...item, in_window: time >= start && time < end });
  }
  for (const item of candidates) item.engagement ??= await kr36Engagement(item.url);
  candidates.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  for (const row of coverage) row.relevant = candidates.filter(c => c.group === row.source && c.in_window).length;

  return { date, window: { start: shanghaiTime(start), end: shanghaiTime(end) }, coverage, candidates };
}

if (process.argv[1]?.endsWith("collect.mjs")) {
  const [date, output] = process.argv.slice(2);
  collect(date)
    .then(result => fs.writeFile(output, JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}

