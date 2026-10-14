import test from "node:test";
import assert from "node:assert/strict";
import { buildDaily, coverageIssues } from "./cloud-daily.mjs";

const DATE = "2026.10.09";
const summary = "某具身机器人团队在真实仓储现场公布新的自主抓取流程，覆盖多种包装与摆放方式，并披露了连续运行的具体任务范围。报道描述了机器人如何感知、规划和完成操作，也列出目前仍需人工处理的例外情形。该进展体现从单项演示进入现场流程的变化，但尚无可独立核实的成本和故障率数据。";
const page = (title = "仓储机器人进入现场", extra = "") => `<html><head><title>${title}</title></head><body>
<p>2026年10月08日 18:00</p>${extra}<p>现场连续运行的新操作流程已经覆盖三类包装。</p></body></html>`;
const item = (n, extra = {}) => ({
  event_key: `robot-deployment-${n}`, tag: "场景", title: `具身机器人仓储部署事件${n}`, summary,
  source: "36氪", source_kind: "media", url: `https://www.36kr.com/p/story-${n}`,
  published_at: "2026-10-08T18:00:00+08:00", first_disclosed_at: "2026-10-08T17:00:00+08:00",
  evidence_quote: "现场连续运行的新操作流程", independent_reports: [], heat_note: "", ...extra
});
const pages = map => async url => map[url] ?? { ok: true, status: 200, body: page() };
const model = (items, coverage = []) => ({ items, rejected: [], watchlist: [], coverage });

test("bad items are dropped with a reason while good ones are kept", async () => {
  const result = await buildDaily(DATE, model([
    item(1), item(2, { first_disclosed_at: "2026-09-25T10:00:00+08:00" }), item(3, { evidence_quote: "原文里没有的一句话测试" })
  ]), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 1);
  assert.match(result.dropped[0].reason, /首次披露时间/);
  assert.match(result.dropped[1].reason, /事实摘录/);
  assert.match(result.payload, /不足 3 条/);
});

test("the 36-hour window accepts an article from the previous evening", async () => {
  const result = await buildDaily(DATE, model([item(1, {
    published_at: "2026-10-07T21:00:00+08:00", first_disclosed_at: "2026-10-07T21:00:00+08:00"
  })]), { fetchPage: pages({ "https://www.36kr.com/p/story-1": { ok: true, status: 200, body: page().replace("2026年10月08日", "2026年10月07日") } }) });
  assert.equal(result.kept.length, 1);
});

test("first-hand and exclusive media reports are kept", async () => {
  const result = await buildDaily(DATE, model([item(1, { source: "36氪", url: "https://www.36kr.com/p/1" })]), {
    fetchPage: pages({ "https://www.36kr.com/p/1": { ok: true, status: 200,
      body: page("某机器人公司完成融资丨36氪首发", "<p>近日，硬氪获悉某公司完成融资。</p><p>来源：硬氪</p>") } })
  });
  assert.equal(result.kept.length, 1);
});

test("outside publisher pages cannot be the final source", async () => {
  const result = await buildDaily(DATE, model([
    item(1, { url: "https://www.prnewswire.com/news/x.html" }),
    item(2, { source: "彭博社", url: "https://www.bloomberg.com/x" })
  ]), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /来源链接/);
  assert.match(result.dropped[1].reason, /发布渠道/);
});

test("items already pushed in the last three issues are dropped", async () => {
  const history = [{ date: "2026.10.08", title: "具身机器人仓储部署事件1", url: "https://other.example.com/a" }];
  const result = await buildDaily(DATE, model([item(1)]), { fetchPage: pages({}), history });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /2026\.10\.08 已推送/);
});

test("domain tags pass and more than six items are capped", async () => {
  const tags = ["深海", "场景", "场景", "场景", "产品", "模型", "政策"];
  const items = tags.map((tag, i) => item(i + 1, { tag }));
  const result = await buildDaily(DATE, model(items), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 6);
  assert.match(result.payload, /^1\. 【深海】/m);
  assert.doesNotMatch(result.payload, /不足 3 条/);
  assert.match(result.dropped[0].reason, /6 条/);
});

test("no qualified items produces an explicit notice", async () => {
  const result = await buildDaily(DATE, model([]), { fetchPage: pages({}) });
  assert.match(result.payload, /没有达到筛选标准/);
  assert.match(result.payload, /36 小时/);
});

test("topic cap keeps the editor-ranked three and allows other topics to fill slots", async () => {
  const ranked = [4, 2, 1, 3].map(n => item(n, { tag: "融资", title: `机器人企业${n}完成新一轮融资` }));
  ranked.push(item(5, { tag: "模型" }), item(6, { tag: "订单" }));
  const result = await buildDaily(DATE, model(ranked), { fetchPage: pages({}) });
  assert.deepEqual(result.kept.map(i => i.url), [4, 2, 1, 5, 6].map(n => `https://www.36kr.com/p/story-${n}`));
  assert.match(result.dropped[0].reason, /融资.*3 条/);
});

test("other final tags do not consume financing quota even when titles mention funding", async () => {
  const tags = ["融资", "融资", "融资", "航天", "深海", "融资"];
  const result = await buildDaily(DATE, model(tags.map((tag, i) => item(i + 1, {
    tag, title: `机器人企业${i + 1}完成新一轮融资`
  }))), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 5);
  assert.deepEqual(result.kept.map(i => i.tag), tags.slice(0, 5));
  assert.match(result.dropped[0].reason, /融资.*3 条/);
});

test("legacy semantic groups do not affect the final-label quota", async () => {
  const tags = ["航天", "深海", "低空", "物流"];
  const result = await buildDaily(DATE, model(tags.map((tag, i) => item(i + 1, {
    tag, topic_group: "场景"
  }))), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 4);
  assert.equal(result.dropped.length, 0);
});

test("invalid candidates do not consume topic quota", async () => {
  const result = await buildDaily(DATE, model([
    item(1, { evidence_quote: "正文不存在的摘录无法核查" }), item(2), item(3), item(4)
  ]), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 3);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /事实摘录/);
});

test("the rejected Shita funding story is excluded across sources without excluding later orders", async () => {
  const result = await buildDaily(DATE, model([
    item(1, { title: "视塔机器人完成天使轮融资", source: "量子位", url: "https://www.qbitai.com/2026/10/shita.html" }),
    item(2, { title: "其他标题也不能重新纳入该快讯", url: "https://www.36kr.com/newsflashes/4023871195467648" }),
    item(3, { title: "视塔机器人获得新的批量交付订单", tag: "订单" })
  ]), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 2);
  assert.match(result.dropped[0].reason, /用户剔除/);
  assert.match(result.kept[0].title, /订单/);
});

test("independent reports count distinct reachable hosts only", async () => {
  const result = await buildDaily(DATE, model([item(1, {
    independent_reports: ["https://www.36kr.com/p/same-host", "https://www.qbitai.com/1", "https://www.qbitai.com/2", "https://www.geekpark.net/x"]
  })]), { fetchPage: pages({ "https://www.geekpark.net/x": { ok: false, status: 404, body: "" } }) });
  assert.equal(result.kept[0].heat.independent_reports.length, 1);
});

test("coverage gaps are reported without blocking the payload", async () => {
  const coverage = [{ source: "机器之心", status: "unavailable", list_status: "unreachable", queries: [] },
    { source: "量子位", status: "checked_none", list_status: "listed", queries: [] }];
  const result = await buildDaily(DATE, model([item(1)], coverage), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 1);
  assert.deepEqual(coverageIssues(model([], coverage)), ["机器之心：列表读取失败且未检索"]);
});

test("citation fragments are stripped from the outgoing summary", async () => {
  const result = await buildDaily(DATE, model([item(1, { summary: summary + " ([example.com](https://example.com/ref))" })]), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 1);
  assert.doesNotMatch(result.payload, /\[example.com\]|\(\[example.com/);
});

test("an approved publisher repost is accepted without replacing its link", async () => {
  const repost = page("转载", "<p>据彭博社报道，融资仍待完成。来源：彭博社。</p>");
  const result = await buildDaily(DATE, model([item(1)]), {
    fetchPage: pages({ "https://www.36kr.com/p/story-1": { ok: true, status: 200, body: repost } })
  });
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].url, "https://www.36kr.com/p/story-1");
  assert.equal(result.kept[0].source, "36氪");
});

test("outside sources are rejected before any fetch and redirects cannot escape", async () => {
  let fetched = 0;
  const result = await buildDaily(DATE, model([
    item(1, { source: "彭博社", url: "https://www.bloomberg.com/x" }),
    item(2, { url: "https://www.cls.cn/detail/2501950" }),
    item(3, { url: "https://www.36kr.com/p/redirect" })
  ]), { fetchPage: async () => { fetched++; return { ok: true, status: 200, body: page(), url: "https://www.bloomberg.com/x" }; } });
  assert.equal(fetched, 1);
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[2].reason, /跳转后/);
});

test("outside supporting links are never fetched", async () => {
  const fetched = [];
  const result = await buildDaily(DATE, model([item(1, {
    independent_reports: ["https://www.bloomberg.com/x", "https://www.cls.cn/x", "https://www.qbitai.com/x"]
  })]), { fetchPage: async url => { fetched.push(url); return { ok: true, status: 200, body: page(), url }; } });
  assert.equal(result.kept.length, 1);
  assert.deepEqual(fetched, ["https://www.36kr.com/p/story-1", "https://www.qbitai.com/x"]);
});

test("an embedded outside URL is dropped before a delivery claim can be made", async () => {
  const result = await buildDaily(DATE, model([item(1, { summary: summary + " 参考 https://www.bloomberg.com/x" }), item(2)]), {
    fetchPage: pages({})
  });
  assert.equal(result.kept.length, 1);
  assert.match(result.dropped[0].reason, /outside/);
  assert.doesNotMatch(result.payload, /bloomberg/);
});
