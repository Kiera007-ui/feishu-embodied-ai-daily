import fs from "node:fs/promises";
import path from "node:path";
import { shiftDate } from "./window.mjs";

// Until 2026.10.12 the sent issue was kept in queue/. From then on the cloud
// daily records what it actually sent in sent/, and queue/ is no longer read
// for dates after the switch (other tools may still write drafts there).
export const SWITCH_DATE = "2026.10.12";

export function parseIssue(text, date) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim());
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^\d+\.\s*【([^】]+)】(.+)$/);
    if (!head) continue;
    const item = { date, tag: head[1], title: head[2].trim(), summary: "", source: "", url: "" };
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
      const line = lines[j];
      if (/^\d+\.\s*【/.test(line)) break;
      if (line.startsWith("来源：")) item.source = line.slice(3).trim();
      else if (/^https?:\/\//.test(line)) item.url = line;
      else if (line && !item.summary) item.summary = line;
    }
    items.push(item);
  }
  return items;
}

export async function loadHistory(date, { days = 3, root = process.cwd() } = {}) {
  const out = [];
  for (let i = 1; i <= days; i += 1) {
    const day = shiftDate(date, -i);
    const files = [path.join(root, "sent", `${day}.txt`)];
    if (day <= SWITCH_DATE) files.push(path.join(root, "queue", `${day}.txt`));
    for (const file of files) {
      try { out.push(...parseIssue(await fs.readFile(file, "utf8"), day)); break; } catch {}
    }
  }
  return out;
}
