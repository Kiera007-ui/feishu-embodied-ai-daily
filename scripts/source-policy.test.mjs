import test from "node:test";
import assert from "node:assert/strict";
import { sourceError, publishedSourceError, accountPublisher, isAllowedSourceUrl, ALLOWED_SOURCE_NAMES, SEARCH_DOMAINS } from "../lib/source-policy.js";
import { searchTool } from "./llm.mjs";
import { REQUIRED_SOURCES, OPTIONAL_SOURCES } from "./collect.mjs";
import { readPage } from "./http.mjs";

test("all eleven channels are required and search uses an explicit domain allowlist", () => {
  assert.equal(ALLOWED_SOURCE_NAMES.length, 11);
  assert.deepEqual(REQUIRED_SOURCES, ALLOWED_SOURCE_NAMES);
  assert.deepEqual(OPTIONAL_SOURCES, []);
  assert.deepEqual(searchTool().filters.allowed_domains, SEARCH_DOMAINS);
  for (const url of ["https://bloomberg.com/x", "https://news.bloomberglaw.com/x", "https://www.cls.cn/x", "https://www.reuters.com/x", "https://techcrunch.com/x"]) {
    assert.equal(isAllowedSourceUrl(url), false);
  }
});

test("publisher identity and domains must agree, including subdomain boundaries", () => {
  assert.equal(sourceError("硬氪（36氪）", "https://www.36kr.com/p/1"), null);
  assert.equal(sourceError("晚点 LatePost", "https://www.latepost.com/news/1"), null);
  assert.match(sourceError("彭博社", "https://www.36kr.com/p/1"), /发布渠道/);
  assert.match(sourceError("量子位", "https://www.infoq.cn/article/1"), /不一致/);
  assert.match(sourceError("36氪", "https://36kr.com.evil.example/x"), /来源链接/);
  assert.match(sourceError("36氪", "https://36kr.com@evil.example/x"), /来源链接/);
  assert.match(sourceError("36氪", "https://evil@36kr.com/x"), /来源链接/);
});

test("approved publisher reposts pass, outside redirects fail", () => {
  const url = "https://www.36kr.com/p/1";
  assert.equal(publishedSourceError("36氪", url, { url, body: "据彭博报道，本文转载自彭博社。" }), null);
  assert.match(publishedSourceError("36氪", url, { url: "https://www.bloomberg.com/x", body: "" }), /跳转后/);
});

test("36Kr account identity comes only from the primary article, not recommendations", () => {
  const url = "https://www.36kr.com/p/1";
  const html = author => `<script>window.initialState=${JSON.stringify({
    articleDetail: { articleDetailData: { data: { author } } },
    recommendations: [{ authorName: "新智元" }]
  })};</script>`;
  assert.equal(accountPublisher(html("新智元"), url), "新智元");
  assert.equal(publishedSourceError("新智元（36氪同步）", url, { url, body: html("新智元") }), null);
  assert.match(publishedSourceError("新智元", url, { url, body: html("其他账号") }), /无法核实/);
  assert.match(publishedSourceError("新智元", url, { url, body: "正文提到新智元" }), /无法核实/);
});

test("WeChat mirrors must identify a listed publisher", () => {
  const url = "https://mp.weixin.qq.com/s/example";
  assert.equal(publishedSourceError("你好太空", url, { url, body: 'var nickname = htmlDecode("你好太空");' }), null);
  assert.equal(publishedSourceError("硅星人", url, { url, body: '<strong class="profile_nickname">硅星人Pro</strong>' }), null);
  assert.match(publishedSourceError("你好太空", url, { url, body: 'var nickname = "其他账号";' }), /无法核实/);
});

test("article reader refuses outside URLs without a network request", async () => {
  const result = await readPage("https://www.bloomberg.com/x");
  assert.equal(result.ok, false);
  assert.match(result.error, /名单/);
});
