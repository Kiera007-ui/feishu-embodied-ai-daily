import test from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "./relay.js";

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
