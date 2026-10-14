import test from "node:test";
import assert from "node:assert/strict";
import relay, { validatePayload, workflowPolicy } from "./relay.js";
import retiredSend from "./send.js";

const workflowRef = name => `Kiera007-ui/feishu-embodied-ai-daily/.github/workflows/${name}@refs/heads/main`;

test("only the cloud workflow can authorize a send", () => {
  for (const event of ["push", "schedule", "workflow_dispatch", "repository_dispatch"]) {
    assert.equal(workflowPolicy(workflowRef("daily-feishu.yml"), event), null);
  }
  for (const event of ["schedule", "workflow_dispatch", "repository_dispatch"]) {
    assert.deepEqual(workflowPolicy(workflowRef("cloud-daily.yml"), event), { mayGoLive: true });
  }
  assert.deepEqual(workflowPolicy(workflowRef("cloud-daily.yml"), "push"), { mayGoLive: false });
  assert.equal(workflowPolicy(workflowRef("cloud-daily.yml").replace("/main", "/other"), "schedule"), null);
  assert.equal(workflowPolicy(workflowRef("cloud-daily.yml"), "pull_request"), null);
});

test("retired manual endpoint and unauthenticated relay never send", async t => {
  let outgoing = 0;
  t.mock.method(globalThis, "fetch", async () => { outgoing++; throw new Error("unexpected network call"); });
  const response = () => ({
    statusCode: null, body: null,
    setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  });
  for (const method of ["GET", "POST", "PUT"]) {
    const res = response();
    await retiredSend({ method, body: { text: "具身智能每日推｜2026.10.13" } }, res);
    assert.equal(res.statusCode, 410);
    assert.equal(res.body.ok, false);
  }
  const res = response();
  await relay({ method: "POST", headers: {}, body: { text: "具身智能每日推｜2026.10.13" } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(outgoing, 0);
});

const payload = (date, n, tag = "【场景】") => [
  `具身智能每日推｜${date}`,
  "",
  ...Array.from({ length: n }, (_, i) => `${i + 1}. ${tag}已核实事件${i + 1}\n内容\n来源：36氪\nhttps://www.36kr.com/p/${i + 1}\n`)
].join("\n");

test("relay accepts up to six items with at most three per topic", () => {
  assert.equal(validatePayload(payload("2026.10.09", 1), "2026.10.09"), null);
  const mixed = payload("2026.10.09", 6).replace(/([456]\. )【场景】/g, "$1【模型】");
  assert.equal(validatePayload(mixed, "2026.10.09"), null);
  assert.match(validatePayload(payload("2026.10.09", 4), "2026.10.09"), /场景.*3 条/);
  assert.match(validatePayload(payload("2026.10.09", 7), "2026.10.09"), /at most 6/);
});

test("relay blocks funding relabels and the rejected Shita event", () => {
  const date = "2026.10.14";
  const financing = payload(date, 4).replace(/【场景】已核实事件([1234])/g, (_, n) =>
    `【${["融资", "航天", "深海", "低空"][Number(n) - 1]}】机器人公司${n}完成新一轮融资`);
  assert.match(validatePayload(financing, date), /融资.*3 条/);
  const excluded = payload(date, 1).replace("已核实事件1", "视塔机器人完成天使轮融资");
  assert.match(validatePayload(excluded, date), /用户剔除/);
});

test("relay requires a notice when there are no items", () => {
  assert.match(validatePayload("具身智能每日推｜2026.10.09\n\n今天没内容", "2026.10.09"), /nothing met/);
  assert.equal(validatePayload("具身智能每日推｜2026.10.09\n\n过去 24 小时内没有达到筛选标准的内容，本期不推送条目。", "2026.10.09"), null);
});

test("relay rejects untagged items and banned links", () => {
  assert.match(validatePayload(payload("2026.10.09", 3, ""), "2026.10.09"), /topic tag/);
  assert.match(validatePayload(payload("2026.10.09", 3).replace("https://www.36kr.com/p/1", "https://finance.sina.com.cn/x"), "2026.10.09"), /banned/);
});

test("relay blocks outside publishers but permits approved-channel reposts", () => {
  const date = "2026.10.13";
  const approved = payload(date, 1).replace("内容", "36氪转载彭博报道，交易仍待完成。");
  assert.equal(validatePayload(approved, date), null);
  assert.match(validatePayload(approved.replace("https://www.36kr.com/p/1", "https://news.bloomberglaw.com/x"), date), /来源链接/);
  assert.match(validatePayload(approved.replace("来源：36氪", "来源：彭博社"), date), /发布渠道/);
  assert.match(validatePayload(approved.replace("来源：36氪\n", ""), date), /publisher/);
  assert.match(validatePayload(approved.replace("交易仍待完成。", "参考 https://www.bloomberg.com/x"), date), /outside/);
});
