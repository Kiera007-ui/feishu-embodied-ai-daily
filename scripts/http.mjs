import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const MARK = "\n__DAILY_HTTP__";

// curl is used instead of fetch because several Chinese media sites send
// certificate chains that Node rejects while curl and browsers accept them.
export function fetchText(url, { timeout = 25 } = {}) {
  return new Promise(resolve => {
    execFile(
      "curl",
      ["-s", "-L", "--compressed", "-m", String(timeout), "-A", UA,
        "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
        "-w", MARK + "%{http_code} %{url_effective}", url],
      { maxBuffer: 60 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        const text = String(stdout || "");
        const i = text.lastIndexOf(MARK);
        if (i < 0) return resolve({ ok: false, status: 0, body: "", url, error: String(error || "no response") });
        const [code, ...rest] = text.slice(i + MARK.length).trim().split(" ");
        const status = Number(code) || 0;
        resolve({ ok: status >= 200 && status < 300, status, body: text.slice(0, i), url: rest.join(" ") || url });
      }
    );
  });
}

export function decodeEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function plainText(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitle(html) {
  const og = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  const title = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return [og?.[1], title?.[1]].filter(Boolean).map(x => decodeEntities(x).trim()).join(" | ");
}

export function postJson(url, body, { timeout = 25 } = {}) {
  return new Promise(resolve => {
    execFile(
      "curl",
      ["-s", "-m", String(timeout), "-X", "POST", "-A", UA,
        "-H", "Content-Type: application/json", "-H", "Origin: https://www.36kr.com", url,
        "-d", JSON.stringify(body)],
      { maxBuffer: 60 * 1024 * 1024, encoding: "utf8" },
      (_error, stdout) => {
        try { resolve(JSON.parse(String(stdout))); } catch { resolve(null); }
      }
    );
  });
}
