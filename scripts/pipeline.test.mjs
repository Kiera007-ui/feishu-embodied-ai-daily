import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { targetWindow, shiftDate } from "./window.mjs";
import { parseIssue, loadHistory } from "./history.mjs";
import { extractJson } from "./llm.mjs";
import { groupFor36krAuthor, preferOwnSite, latepostTime, jiqizhixinTime } from "./collect.mjs";

test("window is the 36 hours before 08:30 Beijing", () => {
  const { start, end } = targetWindow("2026.10.13");
  assert.equal(new Date(end).toISOString(), "2026-10-13T00:30:00.000Z");
  assert.equal(end - start, 36 * 3600_000);
  assert.equal(shiftDate("2026.10.01", -1), "2026.09.30");
});

test("issues are parsed into items and history prefers sent/ over queue/", async () => {
  const issue = "具身智能每日推｜2026.10.11\n\n1. 【场景】机器人进景区\n摘要一\n来源：36氪\nhttps://www.36kr.com/p/1\n";
  assert.deepEqual(parseIssue(issue, "2026.10.11")[0], { date: "2026.10.11", tag: "场景", title: "机器人进景区", summary: "摘要一", source: "36氪", url: "https://www.36kr.com/p/1" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daily-"));
  await fs.mkdir(path.join(root, "queue"));
  await fs.mkdir(path.join(root, "sent"));
  await fs.writeFile(path.join(root, "queue", "2026.10.11.txt"), issue);
  await fs.writeFile(path.join(root, "queue", "2026.10.13.txt"), issue.replace("景区", "草稿"));
  await fs.writeFile(path.join(root, "sent", "2026.10.13.txt"), issue.replace("景区", "工厂"));
  const history = await loadHistory("2026.10.14", { root });
  assert.deepEqual(history.map(h => h.title), ["机器人进工厂", "机器人进景区"]);
  // After the switch, a queue/ draft without a sent record is ignored.
  await fs.rm(path.join(root, "sent", "2026.10.13.txt"));
  assert.deepEqual((await loadHistory("2026.10.14", { root })).map(h => h.title), ["机器人进景区"]);
});

test("36Kr synced articles are linked on the media's own site when available", () => {
  assert.equal(groupFor36krAuthor("量子位"), "量子位");
  assert.equal(groupFor36krAuthor("徐蔡钰"), "36氪/硬氪");
  const own = { group: "量子位", title: "某机器人发布", url: "https://www.qbitai.com/1" };
  const synced = { group: "量子位", title: "某机器人发布", url: "https://www.36kr.com/p/9", synced_on_36kr: true };
  const lone = { group: "新智元", title: "另一篇", url: "https://www.36kr.com/p/8", synced_on_36kr: true };
  const out = preferOwnSite([synced, own, lone]);
  assert.deepEqual(out.map(x => x.url), ["https://www.qbitai.com/1", "https://www.36kr.com/p/8"]);
  assert.deepEqual(own.mirror_urls, ["https://www.36kr.com/p/9"]);
});

test("publisher times are read to the minute", () => {
  assert.equal(latepostTime("10月10日 14:10", Date.parse("2026-10-12T03:00:00Z")), "2026-10-10T14:10:00+08:00");
  assert.equal(latepostTime("12月30日", Date.parse("2027-01-02T03:00:00Z")), "2026-12-30T12:00:00+08:00");
  assert.equal(jiqizhixinTime("2026/10/12 10:40"), "2026-10-12T10:40:00+08:00");
});

test("model JSON is found behind progress notes or code fences", () => {
  const msg = text => ({ type: "message", content: [{ type: "output_text", text }] });
  assert.deepEqual(extractJson({ output: [msg("我先核对。"), msg('{"a":1}')] }), { a: 1 });
  assert.deepEqual(extractJson({ output: [msg("```json\n{\"a\":2}\n```")] }), { a: 2 });
  assert.throws(() => extractJson({ output: [msg("没有 JSON")] }), /no valid JSON/);
});
