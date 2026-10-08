import test from "node:test";
import assert from "node:assert/strict";
import { buildDaily } from "./cloud-daily.mjs";

const DATE = "2026.10.09";
const summary = "某具身机器人团队在真实仓储现场公布新的自主抓取流程，覆盖多种包装与摆放方式，并披露了连续运行的具体任务范围。报道描述了机器人如何感知、规划和完成操作，也列出目前仍需人工处理的例外情形。该进展体现从单项演示进入现场流程的变化，但尚无可独立核实的成本和故障率数据。";
const page = (title = "仓储机器人进入现场") => `<html><head><title>${title}</title></head><body>
<p>2026年10月08日 18:00</p><p>现场连续运行的新操作流程已经覆盖三类包装。</p>
<p>分析人士认为，这比同类演示更接近可复制的现场交付。</p></body></html>`;
const item = (n, extra = {}) => ({
  event_key: `robot-deployment-${n}`, tag: "场景", title: `具身机器人仓储部署事件${n}`, summary,
  source: "示例媒体", url: `https://example.com/story-${n}`,
  published_at: "2026-10-08T18:00:00+08:00", first_disclosed_at: "2026-10-08T17:00:00+08:00",
  evidence_quote: "现场连续运行的新操作流程", analysis_quote: "这比同类演示更接近可复制的现场交付",
  independent_reports: [], heat_note: "", ...extra
});
const pages = map => async url => map[url] ?? { ok: true, status: 200, body: page() };
const model = items => ({ items, rejected: [], watchlist: [], coverage: [] });

test("bad items are dropped with a reason while good ones are kept", async () => {
  const result = await buildDaily(DATE, model([
    item(1), item(2, { first_disclosed_at: "2026-09-25T10:00:00+08:00" }), item(3, { evidence_quote: "原文里没有的一句话测试" })
  ]), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 1);
  assert.match(result.dropped[0].reason, /首次披露时间/);
  assert.match(result.dropped[1].reason, /事实摘录/);
  assert.match(result.payload, /不足 3 条/);
});

test("first-hand and exclusive reports are rejected by page title", async () => {
  const result = await buildDaily(DATE, model([item(1)]), {
    fetchPage: pages({ "https://example.com/story-1": { ok: true, status: 200, body: page("某公司完成融资丨36氪首发") } })
  });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /首发/);
});

test("press release hosts are rejected", async () => {
  const result = await buildDaily(DATE, model([item(1, { url: "https://www.prnewswire.com/news/x.html" })]), { fetchPage: pages({}) });
  assert.match(result.dropped[0].reason, /通稿/);
});

test("domain tags pass and more than six items are capped", async () => {
  const items = Array.from({ length: 7 }, (_, i) => item(i + 1, { tag: i === 0 ? "深海" : "场景" }));
  const result = await buildDaily(DATE, model(items), { fetchPage: pages({}) });
  assert.equal(result.kept.length, 6);
  assert.match(result.payload, /^1\. 【深海】/m);
  assert.doesNotMatch(result.payload, /不足 3 条/);
  assert.match(result.dropped[0].reason, /6 条/);
});

test("no qualified items produces an explicit notice", async () => {
  const result = await buildDaily(DATE, model([]), { fetchPage: pages({}) });
  assert.match(result.payload, /没有达到筛选标准/);
});

test("independent reports count distinct reachable hosts only", async () => {
  const result = await buildDaily(DATE, model([item(1, {
    independent_reports: ["https://example.com/same-host", "https://a.example.org/1", "https://a.example.org/2", "https://down.example.net/x"]
  })]), { fetchPage: pages({ "https://down.example.net/x": { ok: false, status: 404, body: "" } }) });
  assert.equal(result.kept[0].heat.independent_reports.length, 1);
});
