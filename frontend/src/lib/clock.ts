/** Local wall-clock time as HH:MM, for "Saved · 14:32". */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "Today 14:32", "18 Aug" / "8月18日", with the year only when it is not this one. */
export function formatDay(
  iso: string,
  language: "en" | "ja",
  t: (en: string, ja: string) => string,
  now = new Date()
): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return `${t("Today", "今日")} ${formatClock(date.getTime())}`;
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-GB", options).format(date);
}
