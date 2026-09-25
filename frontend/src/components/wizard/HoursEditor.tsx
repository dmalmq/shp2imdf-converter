import { useState, useEffect } from "react";
import { useUiLanguage } from "../../hooks/useUiLanguage";

type DayState = {
  open: boolean;
  from: string;
  to: string;
};

const DAYS: { key: string; label: string; labelJa: string }[] = [
  { key: "Mo", label: "Monday",          labelJa: "月曜日" },
  { key: "Tu", label: "Tuesday",         labelJa: "火曜日" },
  { key: "We", label: "Wednesday",       labelJa: "水曜日" },
  { key: "Th", label: "Thursday",        labelJa: "木曜日" },
  { key: "Fr", label: "Friday",          labelJa: "金曜日" },
  { key: "Sa", label: "Saturday",        labelJa: "土曜日" },
  { key: "Su", label: "Sunday",          labelJa: "日曜日" },
  { key: "PH", label: "Public holidays", labelJa: "祝日" },
];

const DEFAULT_FROM = "09:00";
const DEFAULT_TO = "17:00";

export function parseOsmHours(osm: string): Record<string, DayState> {
  const state: Record<string, DayState> = {};
  for (const day of DAYS) {
    state[day.key] = { open: false, from: DEFAULT_FROM, to: DEFAULT_TO };
  }
  if (!osm) return state;

  const DAY_ORDER = DAYS.map((d) => d.key);
  const segments = osm.split(";").map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const m = seg.match(/^([A-Za-z,\-PH]+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!m) continue;
    const [, dayPart, from, to] = m;
    const keys: string[] = [];
    for (const chunk of dayPart.split(",")) {
      const range = chunk.trim().split("-");
      if (range.length === 2) {
        const startIdx = DAY_ORDER.indexOf(range[0]);
        const endIdx = DAY_ORDER.indexOf(range[1]);
        if (startIdx !== -1 && endIdx !== -1) {
          for (let i = startIdx; i <= endIdx; i++) keys.push(DAY_ORDER[i]);
        }
      } else if (range.length === 1 && DAY_ORDER.includes(range[0])) {
        keys.push(range[0]);
      }
    }
    for (const key of keys) {
      state[key] = { open: true, from, to };
    }
  }
  return state;
}

export function toOsmHours(state: Record<string, DayState>): string | null {
  const DAY_KEYS = DAYS.map((d) => d.key);
  const openDays = DAY_KEYS.filter((k) => state[k]?.open);
  if (openDays.length === 0) return null;

  const groups: { keys: string[]; from: string; to: string }[] = [];
  for (const key of openDays) {
    const { from, to } = state[key];
    const last = groups[groups.length - 1];
    const prevKeyIdx = last ? DAY_KEYS.indexOf(last.keys[last.keys.length - 1]) : -2;
    const curKeyIdx = DAY_KEYS.indexOf(key);
    // PH is not part of the weekday sequence; it must never join a Mo-Su range.
    if (last && key !== "PH" && last.from === from && last.to === to && curKeyIdx === prevKeyIdx + 1) {
      last.keys.push(key);
    } else {
      groups.push({ keys: [key], from, to });
    }
  }

  return groups
    .map(({ keys, from, to }) => {
      const dayStr =
        keys.length >= 3
          ? `${keys[0]}-${keys[keys.length - 1]}`
          : keys.join(",");
      return `${dayStr} ${from}-${to}`;
    })
    .join("; ");
}

type Props = {
  value: string | null;
  onChange: (value: string | null) => void;
};

const TIME_INPUT =
  "h-7 w-[7.5rem] rounded-md border border-input bg-card px-1.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function HoursEditor({ value, onChange }: Props) {
  const { t } = useUiLanguage();
  const [days, setDays] = useState<Record<string, DayState>>(() =>
    parseOsmHours(value ?? "")
  );

  useEffect(() => {
    setDays(parseOsmHours(value ?? ""));
  }, [value]);

  function commit(next: Record<string, DayState>) {
    setDays(next);
    onChange(toOsmHours(next));
  }

  const update = (key: string, patch: Partial<DayState>) => commit({ ...days, [key]: { ...days[key], ...patch } });
  const copyMonday = () => commit(Object.fromEntries(DAYS.map(({ key }) => [key, { ...days.Mo }])));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold leading-[18px] text-foreground">{t("Opening hours", "営業時間")}</h3>
        <button
          type="button"
          onClick={copyMonday}
          disabled={!days.Mo.open}
          title={days.Mo.open ? undefined : t("Open Monday first to copy its hours", "コピーするには月曜日を営業にしてください")}
          className="rounded-sm text-xs leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
        >
          {t("Copy Monday to all", "月曜日を全曜日にコピー")}
        </button>
      </div>
      <ul className="grid gap-x-6 gap-y-2 md:grid-flow-col md:grid-cols-2 md:grid-rows-4">
        {DAYS.map(({ key, label, labelJa }) => {
          const day = days[key];
          const name = t(label, labelJa);
          return (
            <li key={key} className="flex h-8 items-center gap-3">
              <span className={`w-16 shrink-0 text-[13px] md:w-28 ${day.open ? "text-foreground" : "text-muted-foreground"}`}>
                {name}
              </span>
              <div role="group" aria-label={name} className="inline-flex shrink-0 rounded-md bg-muted p-0.5">
                {[true, false].map((open) => (
                  <button
                    key={String(open)}
                    type="button"
                    aria-pressed={day.open === open}
                    onClick={() => update(key, { open })}
                    className={`rounded-[5px] px-2 py-0.5 text-xs leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      day.open === open ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {open ? t("Open", "営業") : t("Closed", "休業")}
                  </button>
                ))}
              </div>
              {day.open ? (
                <span className="flex items-center gap-1.5">
                  <input
                    type="time"
                    value={day.from}
                    aria-label={t(`${label} opens`, `${labelJa}の開始`)}
                    onChange={(e) => update(key, { from: e.target.value })}
                    className={TIME_INPUT}
                  />
                  <span className="font-mono text-xs text-muted-foreground">-</span>
                  <input
                    type="time"
                    value={day.to}
                    aria-label={t(`${label} closes`, `${labelJa}の終了`)}
                    onChange={(e) => update(key, { to: e.target.value })}
                    className={TIME_INPUT}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
