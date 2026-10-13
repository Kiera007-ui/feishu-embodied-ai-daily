// The publishing channel is the gate. Reposts published by these channels are
// allowed, even when the original reporting came from an unlisted outlet.
export const SOURCES = [
  { name: "36氪/硬氪", aliases: ["36氪", "硬氪", "36氪快讯", "硬氪（36氪）"], domains: ["36kr.com"] },
  { name: "量子位", aliases: [], domains: ["qbitai.com"] },
  { name: "机器之心", aliases: [], domains: ["jiqizhixin.com"] },
  { name: "新智元", aliases: [], domains: [] },
  { name: "晚点LatePost", aliases: ["晚点", "LatePost"], domains: ["latepost.com"] },
  { name: "极客公园", aliases: [], domains: ["geekpark.net"] },
  { name: "投资界", aliases: [], domains: ["pedaily.cn"] },
  { name: "AI前线/InfoQ", aliases: ["AI前线", "InfoQ", "极客邦科技InfoQ"], domains: ["infoq.cn"] },
  { name: "甲子光年", aliases: [], domains: ["jazzyear.com"] },
  { name: "硅星人", aliases: ["硅星人Pro"], domains: [] },
  { name: "你好太空", aliases: [], domains: [] }
];

export const ALLOWED_SOURCE_NAMES = SOURCES.map(s => s.name);
export const SEARCH_DOMAINS = [...new Set(SOURCES.flatMap(s => s.domains)), "mp.weixin.qq.com"];
const MIRROR_DOMAINS = ["36kr.com", "mp.weixin.qq.com"];
const key = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function sourceForName(value) {
  const full = key(value);
  const base = full.replace(/[（(][^）)]*[）)]/g, "");
  return SOURCES.find(s => [s.name, ...s.aliases].some(n => key(n) === full || key(n) === base)) || null;
}

function hostOf(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    return url.hostname.toLowerCase();
  } catch { return ""; }
}
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const ownDomain = (source, url) => source.domains.some(d => onDomain(hostOf(url), d));

export function isAllowedSourceUrl(url) {
  const host = hostOf(url);
  return Boolean(host) && SEARCH_DOMAINS.some(d => onDomain(host, d));
}

export function sourceError(name, url) {
  const source = sourceForName(name);
  if (!source) return `发布渠道不在允许名单内：${name || "未标明"}`;
  if (!isAllowedSourceUrl(url)) return "来源链接不属于允许的发布渠道";
  if (!ownDomain(source, url) && !MIRROR_DOMAINS.some(d => onDomain(hostOf(url), d))) {
    return "来源名称与发布网站不一致";
  }
  return null;
}

// Parse the page's primary article state, never recommended articles elsewhere
// on the same page and never executable JavaScript from a fetched page.
function jsonObjectAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at + marker.length);
  if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function decode(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export function accountPublisher(html, url) {
  const host = hostOf(url);
  if (onDomain(host, "36kr.com")) {
    const state = jsonObjectAfter(String(html), "window.initialState=")
      || jsonObjectAfter(String(html), "window.initialState =");
    const article = state?.articleDetail?.articleDetailData?.data;
    const author = typeof article?.author === "string" ? article.author : article?.author?.authorName;
    return sourceForName(article?.authorName || author)?.name || null;
  }
  if (host === "mp.weixin.qq.com") {
    const nickname = String(html).match(/\b(?:var|let|const)\s+nickname\s*=\s*(?:htmlDecode\()?\s*["']([^"']+)["']/)?.[1]
      || String(html).match(/<strong[^>]*class=["'][^"']*profile_nickname[^"']*["'][^>]*>([^<]+)<\/strong>/i)?.[1];
    return sourceForName(decode(nickname))?.name || null;
  }
  return null;
}

export function publishedSourceError(name, url, page) {
  const error = sourceError(name, url);
  if (error) return error;
  const finalUrl = page.url || url;
  const redirectError = sourceError(name, finalUrl);
  if (redirectError) return `跳转后${redirectError}`;
  const source = sourceForName(name);
  if (ownDomain(source, finalUrl)) return null;
  if (accountPublisher(page.body, finalUrl) !== source.name) {
    return "同步页无法核实为名单内媒体账号发布";
  }
  return null;
}

export function payloadSourceError(text) {
  const blocks = String(text).split(/(?=^\d+\.\s+)/m).slice(1);
  for (const block of blocks) {
    const names = [...block.matchAll(/^来源[：:]\s*(.+)$/gm)];
    const links = [...block.matchAll(/^(https?:\/\/\S+)\s*$/gm)];
    if (names.length !== 1 || links.length !== 1) return "Each item needs exactly one publisher and one source link";
    const error = sourceError(names[0][1].trim(), links[0][1].trim());
    if (error) return error;
  }
  for (const link of String(text).match(/https?:\/\/[^\s)\]>]+/gi) || []) {
    if (!isAllowedSourceUrl(link)) return "Payload contains a link outside the approved publishing channels";
  }
  return null;
}
