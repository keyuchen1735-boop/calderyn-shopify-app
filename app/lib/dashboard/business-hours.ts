// Pure local↔UTC whole-hour conversion for the business-hours window.
// guardrail_config stores the window as integer UTC hours; merchants edit
// wall-clock hours in their store timezone. The conversion uses the zone's
// offset at `ref` (defaults to now). NOTE: a single integer UTC hour cannot
// track DST, so an enforced window can drift +/-1h for ~half the year; this is
// an accepted limitation of the existing schema. Half-hour zones (e.g. India)
// are rounded to the nearest whole hour for the same reason.

/** Hours to ADD to a UTC hour to get the local wall-clock hour for `tz` at `ref`. */
export function tzOffsetHours(tz: string, ref: Date): number {
  const hourIn = (timeZone: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(ref),
    );
  let diff = hourIn(tz) - hourIn("UTC");
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return diff;
}

const wrap24 = (h: number) => ((Math.round(h) % 24) + 24) % 24;

export function utcHourToLocal(utcHour: number, tz: string, ref: Date = new Date()): string {
  const local = wrap24(utcHour + tzOffsetHours(tz, ref));
  return `${String(local).padStart(2, "0")}:00`;
}

export function localHourToUtc(localHHmm: string, tz: string, ref: Date = new Date()): number {
  const localHour = Number(String(localHHmm).slice(0, 2));
  return wrap24(localHour - tzOffsetHours(tz, ref));
}
