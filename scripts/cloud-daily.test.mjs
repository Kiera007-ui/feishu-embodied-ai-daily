import test from "node:test";
import assert from "node:assert/strict";
import { buildDaily } from "./cloud-daily.mjs";

const summary = "某具身机器人团队在真实仓储现场公布新的自主抓取流程，覆盖多种包装与摆放方式，并披露了连续运行的具体任务范围。报道描述了机器人如何感知、规划和完成操作，也列出目前仍需人工处理的例外情形。该进展体现从单项演示进入现场流程的变化，但尚无可独立核实的成本和故障率数据。";
const sample = (n, published = "2026-09-29T18:00:00+08:00") => ({
  event_key: `robot-deployment-${n}`,
  tag: "场景",
  title: `具身机器人仓储部署事件${n}`,
  summary,
  source: "示例媒体",
  url: `https://example.com/story-${n}`,
  published_at: published,
  first_disclosed_at: published,
  evidence_quote: "现场连续运行的新操作流程"
});

test("September 30 merges three carryovers with three fresh items", async () => {
  const text = await buildDaily("2026.09.30", JSON.stringify({
    new_items: [sample(1), sample(2), sample(3)]
  }), { verifyLinks: false });
  assert.equal((text.match(/^\d+\. /gm) || []).length, 6);
  assert.match(text, /智元灵犀X2/);
  assert.match(text, /本末科技/);
  assert.match(text, /^1\. 【场景】智元灵犀X2/m);
  assert.match(text, /^2\. 【产品】Sharpa/m);
  assert.match(text, /^3\. 【上市】本末科技/m);
});

test("new items require one short Chinese topic tag", async () => {
  const items = [sample(1), sample(2), sample(3)];
  delete items[0].tag;
  await assert.rejects(
    buildDaily("2026.09.30", JSON.stringify({ new_items: items }), { verifyLinks: false }),
    /Missing tag/
  );
});

test("September 30 rejects a seventh item", async () => {
  await assert.rejects(
    buildDaily("2026.09.30", JSON.stringify({
      new_items: [sample(1), sample(2), sample(3), sample(4)]
    }), { verifyLinks: false }),
    /Too many new items/
  );
});

test("new article with old first disclosure is rejected", async () => {
  const oldEvent = sample(1);
  oldEvent.first_disclosed_at = "2026-09-25T10:00:00+08:00";
  await assert.rejects(
    buildDaily("2026.09.30", JSON.stringify({ new_items: [oldEvent] }), { verifyLinks: false }),
    /first_disclosed_at falls outside/
  );
});

test("later dates do not inherit the September 30 exception", async () => {
  const nextDay = [1, 2, 3, 4, 5, 6].map(n => sample(n, "2026-09-30T18:00:00+08:00"));
  await assert.rejects(
    buildDaily("2026.10.01", JSON.stringify({ new_items: nextDay }), { verifyLinks: false }),
    /Too many new items/
  );
});
