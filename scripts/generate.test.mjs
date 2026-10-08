import test from "node:test";
import assert from "node:assert/strict";
import { parseModelOutput } from "./generate.mjs";

const json = JSON.stringify({ items: [], rejected: [], watchlist: [], coverage: [{ source: "36氪", status: "checked_none", note: "" }] });
const message = text => ({ type: "message", content: [{ type: "output_text", text }] });
const note = "我会核对候选正文、精选。";

test("finds the JSON when progress notes come as a separate message", () => {
  assert.equal(parseModelOutput({ output: [message(note), message(json)] }).coverage[0].source, "36氪");
});

test("finds the JSON when a note is joined in front of it", () => {
  assert.equal(parseModelOutput({ output_text: note + json, output: [message(note + json)] }).coverage.length, 1);
});

test("accepts fenced JSON", () => {
  assert.equal(parseModelOutput({ output: [message("```json\n" + json + "\n```")] }).items.length, 0);
});

test("fails clearly when there is no JSON", () => {
  assert.throws(() => parseModelOutput({ output: [message(note)] }), /no valid daily JSON/);
});
