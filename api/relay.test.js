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
  ...Array.from({ length: n }, (_, i) => `${i + 1}. ${tag}已核实事件${i + 1}\n内容\n来源：测试\nhttps://example.com/${i + 1}\n`)
].join("\n");

test("relay accepts one to six tagged items", () => {
  assert.equal(validatePayload(payload("2026.10.09", 1), "2026.10.09"), null);
  assert.equal(validatePayload(payload("2026.10.09", 6), "2026.10.09"), null);
  assert.match(validatePayload(payload("2026.10.09", 7), "2026.10.09"), /at most 6/);
});

test("relay requires a notice when there are no items", () => {
  assert.match(validatePayload("具身智能每日推｜2026.10.09\n\n今天没内容", "2026.10.09"), /nothing met/);
  assert.equal(validatePayload("具身智能每日推｜2026.10.09\n\n过去 24 小时内没有达到筛选标准的内容，本期不推送条目。", "2026.10.09"), null);
});

test("relay rejects untagged items and banned links", () => {
  assert.match(validatePayload(payload("2026.10.09", 3, ""), "2026.10.09"), /topic tag/);
  assert.match(validatePayload(payload("2026.10.09", 3).replace("https://example.com/1", "https://finance.sina.com.cn/x"), "2026.10.09"), /banned/);
});
