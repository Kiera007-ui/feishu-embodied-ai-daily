export const MAX_ITEMS_PER_TOPIC = 3;

// Importance is assessed before quota checks. Only the final displayed label
// consumes quota; titles and hidden semantic groups do not add a second count.
export function topicGroups(item) {
  const tag = String(item.tag || "").trim();
  return tag ? [tag] : [];
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
  return full ? `同标签【${full}】超过 ${MAX_ITEMS_PER_TOPIC} 条上限，保留已排序的较重要条目` : null;
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
