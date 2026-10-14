export const MAX_ITEMS_PER_TOPIC = 3;

const aliases = new Map([
  ["投融资", "融资"], ["募资", "融资"], ["融资进展", "融资"],
  ["部署", "场景"], ["应用", "场景"], ["落地", "场景"],
  ["新品", "产品"], ["产品发布", "产品"], ["大模型", "模型"],
  ["客户", "订单"], ["交付", "订单"], ["产能", "量产"], ["上市进展", "上市"]
]);
const canonical = value => aliases.get(String(value || "").trim()) || String(value || "").trim();

// Count both the displayed label and the core-fact group. Domain labels cannot
// hide a fourth funding story. The editor supplies the semantic group from body reading.
export function topicGroups(item) {
  const groups = new Set([canonical(item.tag), canonical(item.topic_group)].filter(Boolean));
  if (/融资|募资|获投|获投资|获.*轮投资|完成.*轮.*投资/.test(item.title || "")) groups.add("融资");
  return [...groups];
}

export function excludedEventReason(item) {
  let pathname = "";
  try { pathname = new URL(item.url).pathname; } catch {}
  if (pathname === "/newsflashes/4023871195467648"
      || (/视塔机器人/.test(item.title || "") && /天使轮/.test(item.title || "") && /融资|获投|投资/.test(item.title || ""))) {
    return "用户剔除：视塔机器人本次天使轮融资报道，缺少有价值的产品、客户或落地事实";
  }
  return null;
}

export function topicLimitError(item, counts) {
  const full = topicGroups(item).find(group => (counts.get(group) || 0) >= MAX_ITEMS_PER_TOPIC);
  return full ? `同领域【${full}】超过 ${MAX_ITEMS_PER_TOPIC} 条上限，保留已排序的较重要条目` : null;
}

export function countTopics(item, counts) {
  for (const group of topicGroups(item)) counts.set(group, (counts.get(group) || 0) + 1);
}

export function payloadEditorialError(payload) {
  const counts = new Map();
  const blocks = String(payload).split(/(?=^\d+\.\s+【)/m).slice(1);
  for (const block of blocks) {
    const head = block.match(/^\d+\.\s+【([^】]+)】([^\r\n]+)/);
    if (!head) continue;
    const item = { tag: head[1], title: head[2], url: block.match(/^https?:\/\/\S+/m)?.[0] || "" };
    const error = excludedEventReason(item) || topicLimitError(item, counts);
    if (error) return error;
    countTopics(item, counts);
  }
  return null;
}
