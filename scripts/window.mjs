export function targetWindow(date) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(String(date))) throw new Error("Invalid target date");
  const end = Date.parse(`${date.replaceAll(".", "-")}T09:00:00+08:00`);
  if (!Number.isFinite(end)) throw new Error("Invalid target date");
  return { start: end - 86_400_000, end };
}

export function shanghaiTime(millis) {
  return new Date(millis + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

export function shanghaiDate(millis = Date.now()) {
  return shanghaiTime(millis).slice(0, 10).replaceAll("-", ".");
}
