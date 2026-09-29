import test from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "./relay.js";

const payload = date => [
  `具身智能每日推｜${date}`,
  "",
  ...Array.from({ length: 6 }, (_, i) => `${i + 1}. 已核实事件${i + 1}\n内容\n来源：测试\nhttps://example.com/${i + 1}\n`)
].join("\n");

test("relay allows six items only on September 30", () => {
  assert.equal(validatePayload(payload("2026.09.30"), "2026.09.30"), null);
  assert.match(validatePayload(payload("2026.10.01"), "2026.10.01"), /3-5/);
});
