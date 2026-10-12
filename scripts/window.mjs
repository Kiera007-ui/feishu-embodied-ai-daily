// Each issue covers the 36 hours before 08:30 Beijing time on its date.
// Consecutive windows overlap by 12 hours; history checks stop repeats.
export const WINDOW_HOURS = 36;
export const CUTOFF = "08:30";

export function targetWindow(date) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(String(date))) throw new Error("Invalid target date");
  const end = Date.parse(`${date.replaceAll(".", "-")}T${CUTOFF}:00+08:00`);
  if (!Number.isFinite(end)) throw new Error("Invalid target date");
  return { start: end - WINDOW_HOURS * 3600_000, end };
}

export function shanghaiTime(millis) {
  return new Date(millis + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

export function shanghaiDate(millis = Date.now()) {
  return shanghaiTime(millis).slice(0, 10).replaceAll("-", ".");
}

export function shiftDate(date, days) {
  const millis = Date.parse(`${date.replaceAll(".", "-")}T12:00:00+08:00`) + days * 86_400_000;
  return shanghaiDate(millis);
}
