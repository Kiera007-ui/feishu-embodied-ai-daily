import fs from "node:fs/promises";
import { runModel } from "./llm.mjs";
import { readPage, plainText } from "./http.mjs";
import { targetWindow, shanghaiTime } from "./window.mjs";
import { REQUIRED_SOURCES, SEARCH_SOURCES, OPTIONAL_SOURCES, readCandidate } from "./collect.mjs";
import { loadHistory } from "./history.mjs";
import { sourceError } from "../lib/source-policy.js";

// The selection runs in stages so each judgement gets its own search budget:
// sweep (find what the lists missed) -> triage (group into events and rank)
// -> verify (one call per event) -> editor (final order). Code checks follow.
const MAX_EVENTS = Number(process.env.DAILY_MAX_EVENTS || 12);
const CONCURRENCY = Number(process.env.DAILY_CONCURRENCY || 4);
const VERIFY_BUDGET_MS = Number(process.env.DAILY_VERIFY_MINUTES || 35) * 60_000;

const str = { type: "string" };
const obj = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = items => ({ type: "array", items });

const CANDIDATE = obj({ title: str, url: str, source: str, published_at: str, note: str });
const SWEEP_SCHEMA = obj({
  candidates: arr(CANDIDATE),
  searched: arr(obj({ source: str, queries: arr(str), result: str }))
});
const TRIAGE_SCHEMA = obj({
  events: arr(obj({ event_key: str, headline: str, candidate_urls: arr(str), priority: { type: "integer" }, why: str })),
  rejected: arr(obj({ title: str, url: str, reason: str }))
});
export const VERIFY_SCHEMA = obj({
  decision: { type: "string", enum: ["include", "watch", "reject"] },
  reason: str, event_key: str, tag: str, title: str, summary: str, source: str, url: str,
  source_kind: { type: "string", enum: ["media", "company", "other"] },
  published_at: str, first_disclosed_at: str, evidence_quote: str,
  independent_reports: arr(str), heat_note: str
});
const EDITOR_SCHEMA = obj({ order: arr(obj({ event_key: str, keep: { type: "boolean" }, reason: str })) });

async function context(date) {
  const { start, end } = targetWindow(date);
  let focus = "";
  try {
    const configured = JSON.parse(await fs.readFile(new URL("../config/daily-focus.json", import.meta.url), "utf8"));
    if (configured.date === date) focus = configured.instructions || "";
  } catch {}
  const rules = (await fs.readFile(new URL("../prompts/rules.md", import.meta.url), "utf8"))
    .replaceAll("{{WINDOW_START}}", shanghaiTime(start)).replaceAll("{{WINDOW_END}}", shanghaiTime(end));
  const cases = await fs.readFile(new URL("../prompts/cases.md", import.meta.url), "utf8");
  return { start, end, rules, cases, focus };
}

const historyBlock = history => history.length
  ? history.map(h => `- ${h.date} 【${h.tag}】${h.title}：${h.summary.slice(0, 120)} ${h.url}`).join("\n")
  : "（无记录）";

const brief = (c, chars) => ({
  title: c.title, source: c.source, author: c.author || undefined, synced_on_36kr: c.synced_on_36kr || undefined,
  url: c.url, published_at: c.published_at, time_precision: c.time_precision, engagement: c.engagement,
  read_status: c.read_status || "not_read", text: (c.article_text || c.summary || "").slice(0, chars)
});

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); }
  }));
  return results;
}

async function sweep(date, collected, ctx) {
  const focus = ctx.focus ? "\n\n## 本期定向关注\n" + ctx.focus : "";
  const listed = collected.coverage.map(r => `${r.source}：${r.status}，列表 ${r.found} 篇，窗口内相关 ${r.relevant ?? 0} 篇`).join("\n");
  const known = collected.candidates.filter(c => c.in_window).map(c => `- ${c.title}（${c.source}）`).join("\n") || "（无）";
  const weak = collected.coverage.filter(r => REQUIRED_SOURCES.includes(r.source) && (r.status === "unreachable" || !r.relevant)).map(r => r.source);
  const sourcesTask = `你在为《具身智能每日推》补充候选文章。${focus}\n程序从各来源文章列表采集的情况如下：
${listed}

请用网页搜索补查以下来源在窗口内发表的文章：
- ${[...new Set([...SEARCH_SOURCES, ...weak])].join("、")}：每家至少两次定向检索；同时执行本期定向关注中的具体关键词组合。
- 新智元、硅星人、你好太空：检索名单内媒体网站的刊登页，或能核实账号名称的 36氪同步页、微信公众号页；不能用任意同名转载账号代替。
只返回允许名单内媒体在窗口内发布、与规则范围相关、你实际打开过的文章。source 填发布该页面的名单内媒体，不填被转载的原始媒体。转载允许，保留名单内的刊登链接，不追换到名单外原文。searched 逐一记录每个来源的实际检索词和结果。

已采集的窗口内候选（不必重复返回）：
${known}`;
  const eventsTask = `你在为《具身智能每日推》补充候选文章。${focus}\n请仅在允许名单内媒体发布的网页中，检索窗口内具身智能及相关硬科技的新消息，覆盖：人形机器人、具身模型、灵巧手与核心部件、机器人融资/订单/量产/部署/上市、仓储物流与无人配送、深海/航天/低空智能装备、重要政策。名单是检索、核查和最终发布来源的硬边界，不能扩大为其他专业媒体。
特别注意：
- 标题和导语不点名“机器人”、但正文是机器人系统发布或部署的报道（例如在 IROS 等展会上同时发布本体、灵巧手、数据手套）。
- 名单内媒体刊登的机器人新品、融资、订单报道，包括它们转载其他来源的内容；不要求独立采写。
- 若名单内文章引用彭博、Reuters等原始来源，可使用该刊登页，但不能改用名单外原文作为候选或补充证据。
只返回名单内媒体在窗口内发布、你实际打开过的文章，最多 25 篇。source 填名单内的发布媒体；searched 记录检索主题和结果。工博会专题必须打开正文判断，不能只凭标题；正文必须包含具体机器人／智能装备、发布、应用、订单、部署或产业化事实，否则剔除。

已采集的窗口内候选（不必重复返回）：
${known}`;
  const runs = await Promise.allSettled([
    runModel({ name: "sweep_sources", input: `${ctx.rules}\n\n${sourcesTask}`, schema: SWEEP_SCHEMA, effort: "medium", search: true }),
    runModel({ name: "sweep_events", input: `${ctx.rules}\n\n${eventsTask}`, schema: SWEEP_SCHEMA, effort: "medium", search: true })
  ]);
  const metas = [], searched = [], found = [];
  for (const run of runs) {
    if (run.status !== "fulfilled") { console.log(`[sweep] failed: ${String(run.reason?.message || run.reason).slice(0, 300)}`); continue; }
    metas.push(run.value.meta);
    searched.push(...(run.value.value.searched || []));
    found.push(...(run.value.value.candidates || []));
  }
  // Read every new article ourselves; the model's claim that a page exists is not enough.
  const seen = new Set(collected.candidates.map(c => c.url));
  const added = [];
  for (const c of found) {
    if (sourceError(c.source, c.url) || seen.has(c.url)) continue;
    seen.add(c.url);
    added.push({ title: c.title, url: c.url, source: c.source, group: c.source, published_at: c.published_at,
      summary: c.note, origin: "search", in_window: true });
  }
  await pool(added, 6, readCandidate);
  const readable = added.filter(c => c.read_status === "readable");
  console.log(`[sweep] ${found.length} returned, ${added.length} new, ${readable.length} readable`);
  return { metas, searched, added: readable, unreadable: added.filter(c => c.read_status !== "readable") };
}

async function triage(date, candidates, history, ctx) {
  const input = `${ctx.rules}

${ctx.cases}

## 前 3 期已推送
${historyBlock(history)}

## 任务
下面是窗口内全部候选（含正文节选）。程序已确认这些文章的发布时间都在窗口内，不要再以发布时间为由剔除；只有正文明确显示核心事实在窗口开始前已经公开时，才按旧闻剔除。请：
1. 把报道同一事件的候选归为一组，用一个简短英文 event_key 标识；
2. 剔除明显超出范围、核心事实为旧闻、与前 3 期重复的候选，写进 rejected 并说明原因；
3. 对剩余事件按重要性和热度排序，选出最多 ${MAX_EVENTS} 个最值得逐个核查的事件，priority 用 1–5（5 最高）。
宁可多留几个边缘事件交给下一步核查，也不要漏掉重要事件；目标是最终能有 3–6 条。候选足够时至少保留 8 个事件。公司自发内容也要保留为事件，下一步会去找媒体报道。
candidate_urls 只能使用下列候选中的 url。

## 候选
${JSON.stringify(candidates.map(c => brief(c, 1500)), null, 1)}`;
  return runModel({ name: "triage", input, schema: TRIAGE_SCHEMA, effort: "high", timeout: 15 * 60_000 });
}

async function verifyEvent(event, byUrl, history, ctx) {
  const articles = event.candidate_urls.map(url => byUrl.get(url)).filter(Boolean).slice(0, 4).map(c => brief(c, 9000));
  const input = `${ctx.rules}

${ctx.cases}

## 前 3 期已推送
${historyBlock(history)}

## 任务
只核查下面这一个事件能否入选，并在能入选时写出条目。需要时联网检索：
- 仅在允许名单内刊登的正文和往日报道中追溯核心事实的首次披露时间；无法确认则 watch，不去名单外补证；
- 按发布媒体判断来源，名单内转载可以入选，无需独立采写，不因引用彭博等名单外原始信源而排除；
- 保留名单内刊登页；仅当另一名单内媒体有同文官网页时才可替换，绝不能追换到名单外原文；
- 只用名单内媒体报道评估热度，转载同一原始报道不算多家独立报道。
decision：include（满足全部规则，写完整条目）；watch（值得跟进但暂无合格来源或时间无法确认）；reject（不符合规则）。reason 用一句话说明。
不是 include 时，条目字段填空字符串、independent_reports 填空数组。source 和 source_kind 按刊登页面所属媒体填写，名单内刊登页填 media，不能填被转载的原始机构。independent_reports 只放允许名单内链接。
evidence_quote 必须从 url 页面原文逐字摘录。先读正文判断价值，按重要性规则剔除只有泛泛用途和研发方向的普通融资官宣，再根据有价值的核心内容选 tag。用航天、深海、低空等领域标签时，reason 必须指出正文中的具体能力、应用、订单、部署或产业化事实；不能只因公司属于该领域就改标签。

## 事件
${event.headline}（event_key: ${event.event_key}；初筛理由：${event.why}）

## 候选文章
${JSON.stringify(articles, null, 1)}`;
  return runModel({ name: `verify_${event.event_key}`.slice(0, 60).replace(/[^\w-]/g, "_"), input, schema: VERIFY_SCHEMA, effort: "high", search: true, timeout: 20 * 60_000 });
}

async function editor(items, history, ctx) {
  const input = `${ctx.rules}

## 前 3 期已推送
${historyBlock(history)}

## 任务
你是主编。下面是逐条核查后可以入选的条目。请：去掉同一事件的重复条目和与前 3 期重复的条目；按重要性和热度排序；keep=true 的最多 8 条（程序还会逐条硬校验，最终最多发 6 条）。只按最终展示 tag 计数，每个标签最多保留 3 条；其余标签不额外占融资名额。先核查内容价值和标签依据，不能为了保留低价值融资稿而改标签；领域标签需有具体能力、应用、订单、部署或产业化事实支撑，仅有公司领域和泛泛研发方向时剔除。读摘要中的具体新事实，先比产业影响、产品能力、客户／订单／部署／量产证据，再考虑融资规模、估值变化，最后用热度辅助，剔除低价值官宣。超过三条的标签必须比较并在 reason 写出保留或剔除理由，不能机械保留前 3 条。不要改写条目内容。每条都要出现在 order 里，reason 一句话；领域标签条目同时说明正文依据。

## 条目
${JSON.stringify(items.map(i => ({ event_key: i.event_key, tag: i.tag, title: i.title, summary: i.summary, source: i.source, url: i.url, published_at: i.published_at, verification_reason: i.reason, heat_note: i.heat_note, independent_reports: i.independent_reports.length })), null, 1)}`;
  return runModel({ name: "editor", input, schema: EDITOR_SCHEMA, effort: "high", timeout: 10 * 60_000 });
}

const chars = value => [...String(value || "").trim()].length;
export const LIMITS = { title: [8, 50], summary: [120, 200] };
export const needsFix = item => Object.entries(LIMITS).some(([k, [min, max]]) => chars(item[k]) < min || chars(item[k]) > max);

// The checker drops items whose title or summary is outside the length limits.
// Rewording is cheaper than losing an otherwise good item.
async function fixLengths(items, metas) {
  const targets = items.map((item, index) => ({ index, item })).filter(({ item }) => needsFix(item));
  if (!targets.length) return items;
  const schema = obj({ items: arr(obj({ index: { type: "integer" }, title: str, summary: str })) });
  const input = ["下面是日推条目的标题和摘要，长度不符合要求。逐条改写：",
    "- title：8–50 个字符，陈述核心事实。",
    "- summary：120–200 个字符（中文、英文字母、数字、标点和空格都按 1 个字符计）。",
    "只压缩或调整措辞，保留原有事实和关键数字，不增加任何新信息。只输出 JSON。",
    JSON.stringify(targets.map(({ index, item }) => ({ index, title: item.title, summary: item.summary })), null, 1)].join("\n");
  try {
    const r = await runModel({ name: "length_fix", input, schema, effort: "low", timeout: 5 * 60_000 });
    metas.push(r.meta);
    for (const entry of r.value.items) {
      const item = items[entry.index];
      if (item && !needsFix({ ...item, ...entry })) Object.assign(item, { title: entry.title, summary: entry.summary });
    }
  } catch (error) {
    console.log(`[length_fix] failed: ${String(error.message).slice(0, 200)}`);
  }
  return items;
}

export function coverageRows(collected, searched) {
  return [...REQUIRED_SOURCES, ...OPTIONAL_SOURCES].map(source => {
    const row = collected.coverage.find(r => r.source === source) || {};
    const key = source.split("/")[0].replace("LatePost", "");
    const hits = searched.filter(s => s.source && (s.source.includes(key) || source.includes(s.source)));
    const queries = hits.flatMap(h => h.queries);
    let status = "checked_none";
    if (row.relevant > 0) status = "found";
    else if (row.status === "unreachable" && !queries.length) status = "unavailable";
    return { source, status, list_status: row.status || "none", listed: row.found ?? 0, relevant: row.relevant ?? 0,
      queries, note: [row.note, ...hits.map(h => h.result)].filter(Boolean).join("；").slice(0, 300) };
  });
}

export async function select(date, collected, { root = process.cwd() } = {}) {
  const ctx = await context(date);
  const history = await loadHistory(date, { root });
  const metas = [];

  const swept = await sweep(date, collected, ctx);
  metas.push(...swept.metas);
  const candidates = [...collected.candidates.filter(c => c.in_window && c.read_status === "readable" && !sourceError(c.source, c.url)), ...swept.added];
  const byUrl = new Map(candidates.map(c => [c.url, c]));
  console.log(`[select] ${candidates.length} candidates in window, ${history.length} history items`);

  const rejected = [];
  const watchlist = [];
  let events = [];
  if (candidates.length) {
    const t = await triage(date, candidates, history, ctx);
    metas.push(t.meta);
    rejected.push(...(t.value.rejected || []));
    events = (t.value.events || [])
      .map(e => ({ ...e, candidate_urls: e.candidate_urls.filter(url => byUrl.has(url)) }))
      .filter(e => e.candidate_urls.length)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_EVENTS);
  }
  console.log(`[select] ${events.length} events to verify`);

  const started = Date.now();
  const verified = await pool(events, CONCURRENCY, async event => {
    if (Date.now() - started > VERIFY_BUDGET_MS) return { event, error: "核查时间用尽，未核查" };
    try { return { event, ...(await verifyEvent(event, byUrl, history, ctx)) }; }
    catch (error) { return { event, error: String(error.message || error).slice(0, 300) }; }
  });
  const included = [];
  for (const v of verified) {
    const title = v.event.headline;
    const url = v.event.candidate_urls[0];
    if (v.error) { rejected.push({ title, url, reason: `核查失败：${v.error}` }); continue; }
    metas.push(v.meta);
    const r = v.value;
    if (r.decision === "include" && r.source_kind === "company") {
      watchlist.push({ name: title, reason: "未找到名单内媒体的刊登页", url: r.url || url });
    } else if (r.decision === "include") {
      included.push({ ...r, event_key: r.event_key || v.event.event_key, priority: v.event.priority });
    } else if (r.decision === "watch") {
      watchlist.push({ name: title, reason: r.reason, url });
    } else {
      rejected.push({ title, url, reason: r.reason });
    }
  }

  let items = included;
  let editorialDecisions = [];
  if (included.length > 1) {
    try {
      const e = await editor(included, history, ctx);
      metas.push(e.meta);
      editorialDecisions = e.value.order.map(o => ({ ...o, title: included.find(i => i.event_key === o.event_key)?.title || o.event_key }));
      const rank = new Map(e.value.order.map((o, i) => [o.event_key, { i, ...o }]));
      for (const item of included) {
        const o = rank.get(item.event_key);
        if (o && !o.keep) rejected.push({ title: item.title, url: item.url, reason: `主编未选：${o.reason}` });
      }
      items = included.filter(i => rank.get(i.event_key)?.keep !== false)
        .sort((a, b) => (rank.get(a.event_key)?.i ?? 99) - (rank.get(b.event_key)?.i ?? 99));
    } catch (error) {
      console.log(`[editor] failed, keeping triage order: ${String(error.message).slice(0, 200)}`);
      items = included.sort((a, b) => b.priority - a.priority);
    }
  }

  const queries = metas.flatMap(m => m.queries || []);
  return {
    items: await fixLengths(items.slice(0, 8), metas),
    editorial_decisions: editorialDecisions,
    rejected: rejected.slice(0, 30),
    watchlist: watchlist.slice(0, 8),
    coverage: coverageRows(collected, swept.searched),
    meta: {
      model: metas[0]?.model, searches: queries.length, search_queries: queries,
      stages: metas.map(m => ({ stage: m.stage, seconds: m.seconds, searches: m.searches, response_id: m.response_id })),
      swept_added: swept.added.length, events: events.length, verified_included: included.length, history: history.length
    }
  };
}

if (process.argv[1]?.endsWith("select.mjs")) {
  const [date, input, output] = process.argv.slice(2);
  fs.readFile(input, "utf8")
    .then(raw => select(date, JSON.parse(raw)))
    .then(result => fs.writeFile(output, JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
