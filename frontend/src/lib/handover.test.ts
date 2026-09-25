import { describe, expect, it } from "vitest";

import type { Handover, HandoverEvent } from "../api/client";
import { eventLine, formatDuration, shouldWelcome } from "./handover";

function event(kind: HandoverEvent["kind"], n = 1, params: HandoverEvent["params"] = {}): HandoverEvent {
  return { at: "2026-09-24T10:00:00Z", kind, n, params };
}

const visit = { started_at: "2026-09-24T09:00:00Z", ended_at: "2026-09-24T10:40:00Z", events: [], dropped: 0 };

describe("eventLine", () => {
  it("counts things in both languages", () => {
    expect(eventLine(event("features_edited", 3))).toEqual({ en: "Edited 3 features", ja: "3 件のフィーチャーを編集" });
    expect(eventLine(event("features_edited", 1)).en).toBe("Edited 1 feature");
    expect(eventLine(event("imported", 1, { files: 16 }))).toEqual({
      en: "Brought in 16 files",
      ja: "16 ファイルを取り込み"
    });
  });

  it("names the section and the output", () => {
    expect(eventLine(event("setup_changed", 1, { section: "levels" })).en).toBe("Changed the level mapping");
    expect(eventLine(event("delivered", 2, { format: "imdf" }))).toEqual({
      en: "Delivered the IMDF archive (2 times)",
      ja: "IMDF アーカイブを書き出し（2 回）"
    });
    expect(eventLine(event("delivered", 1, { format: "shapefiles:odc2026" })).en).toBe(
      "Delivered the Open Data Contest 2026"
    );
  });
});

describe("formatDuration", () => {
  it("reads like the design", () => {
    expect(formatDuration(100 * 60000)).toEqual({ en: "1 h 40 min", ja: "1時間40分" });
    expect(formatDuration(25 * 60000).en).toBe("25 min");
    expect(formatDuration(120 * 60000).en).toBe("2 h");
    expect(formatDuration(10000).en).toBe("under a minute");
  });
});

describe("shouldWelcome", () => {
  const resumed: Handover = { visit_started_at: "2026-09-25T08:00:00Z", last_visit: visit, note: null };

  it("shows once per visit after an earlier one changed something", () => {
    expect(shouldWelcome(resumed, null)).toBe(true);
    expect(shouldWelcome(resumed, "2026-09-25T08:00:00Z")).toBe(false);
    expect(shouldWelcome(resumed, "2026-09-24T09:00:00Z")).toBe(true);
  });

  it("stays away from a project's first visit", () => {
    expect(shouldWelcome({ ...resumed, last_visit: null }, null)).toBe(false);
  });
});
