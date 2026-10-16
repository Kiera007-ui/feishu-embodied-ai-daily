import test from "node:test";
import assert from "node:assert/strict";
import { selectionContext } from "./select.mjs";
import { shanghaiTime } from "./window.mjs";

test("Oct 17 focus reaches shared rules with the correct window and review constraints", async () => {
  const ctx = await selectionContext("2026.10.17");
  assert.equal(shanghaiTime(ctx.start), "2026-10-15T20:30:00+08:00");
  assert.equal(shanghaiTime(ctx.end), "2026-10-17T08:30:00+08:00");
  assert.ok(ctx.focus.includes("https://www.geekpark.net/news/372459"));
  assert.ok(ctx.rules.includes(ctx.focus));
  assert.match(ctx.rules, /不保证入选/);
  assert.match(ctx.rules, /无法确认则 watch/);
  assert.match(ctx.rules, /不计为多家独立报道/);
  assert.match(ctx.rules, /前3期事件去重/);
});

test("dated focus cannot affect today and expires on the next day", async () => {
  for (const date of ["2026.10.16", "2026.10.18", "2026.10.19"]) {
    const ctx = await selectionContext(date);
    assert.equal(ctx.focus, "");
    assert.ok(!ctx.rules.includes("372459"));
    assert.ok(!ctx.rules.includes("本期定向关注"));
    assert.match(ctx.rules, /11 个渠道均须逐源检查/);
    assert.match(ctx.rules, /甲子光年/);
  }
});
