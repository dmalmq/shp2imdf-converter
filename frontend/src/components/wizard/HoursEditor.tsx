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
  { key: "PH", label: "Public Holidays", labelJa: "祝日" },
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

export function HoursEditor({ value, onChange }: Props) {
  const { t } = useUiLanguage();
  const [days, setDays] = useState<Record<string, DayState>>(() =>
    parseOsmHours(value ?? "")
  );

  useEffect(() => {
    setDays(parseOsmHours(value ?? ""));
  }, [value]);

  function update(key: string, patch: Partial<DayState>) {
    setDays((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      onChange(toOsmHours(next));
      return next;
    });
  }

  return (
    <div className="space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
      {DAYS.map(({ key, label, labelJa }) => {
        const day = days[key];
        return (
          <div key={key} className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => update(key, { open: !day.open })}
              className={`w-5 h-5 flex-shrink-0 rounded border text-xs font-bold transition-colors ${
                day.open
                  ? "border-blue-500 bg-blue-500 text-white"
                  : "border-slate-300 bg-white text-slate-400"
              }`}
              aria-label={day.open ? `Close ${label}` : `Open ${label}`}
            >
              {day.open ? "✓" : ""}
            </button>
            <span className={`w-32 flex-shrink-0 ${day.open ? "text-slate-800" : "text-slate-400"}`}>
              {t(label, labelJa)}
            </span>
            {day.open ? (
              <div className="flex items-center gap-1">
                <input
                  type="time"
                  value={day.from}
                  onChange={(e) => update(key, { from: e.target.value })}
                  className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                />
                <span className="text-slate-400">–</span>
                <input
                  type="time"
                  value={day.to}
                  onChange={(e) => update(key, { to: e.target.value })}
                  className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                />
              </div>
            ) : (
              <span className="text-xs text-slate-400">{t("Closed", "休業")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
