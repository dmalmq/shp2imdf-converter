import type { ColorThemeCounts, ColorThemeInspection, ColorThemeReport, ColorThemeRule } from "../api/client";

const AREAS = {
  free_area: { name: { en: "Free area outside the gates", ja: "改札外通路" }, spec: "Mono 000", hex: "#FFFFFF" },
  paid_area: { name: { en: "Paid area, conventional lines", ja: "在来線改札内" }, spec: "PaleBlue 050", hex: "#F2F7FB" },
  paid_area_shinkansen: { name: { en: "Paid area, Shinkansen", ja: "新幹線改札内" }, spec: "PaleBlue 100", hex: "#E5EFF7" },
  facilities: { name: { en: "Facilities", ja: "施設" }, spec: "Turquoise 150", hex: "#DDEBEC" },
  restricted: { name: { en: "Restricted area", ja: "進入制限エリア" }, spec: "Mono 050", hex: "#F2F2F2" },
  stairs_escalators: { name: { en: "Stairs and escalators", ja: "階段・エスカレーター" }, spec: "Mono 000", hex: "#FFFFFF" }
} as const;

type Line = [old: string, oldHex: string | null, scope: string, area: keyof typeof AREAS, categories?: string[]];

/** `backend/config/color_theme.json`'s rules, in its order. */
const LINES: Line[] = [
  ["黄", "#FCFCE3", "JR East floors inside the gates", "paid_area"],
  ["橙", "#FFE8BF", "JR Central Shinkansen floors inside the gates", "paid_area_shinkansen"],
  ["緑", "#DDF5D9", "JR East Shinkansen floors inside the gates", "paid_area_shinkansen"],
  ["ラチ外白", "#FFFFFF", "Floors outside the gates", "free_area"],
  ["薄紅", "#FFECE6", "Conventional line platforms", "paid_area"],
  ["濃紅", "#F2CFC2", "Shinkansen platforms", "paid_area_shinkansen"],
  ["薄空", "#E5F8FF", "Shops and public facilities outside the gates, ticket offices", "facilities"],
  ["濃空", "#C2E5F2", "Shops and public facilities inside the gates", "facilities"],
  ["薄鼠", "#E5E6E6", "Waiting rooms, lifts, station offices, other rooms", "restricted"],
  ["白", "#FFFFFF", "Stairs, escalators, moving walkways, voids", "stairs_escalators"],
  ["トイレ", "#E5E6E6", "Toilets", "facilities"],
  ["濃鼠", null, "Floor 0 outside the gates", "free_area"],
  ["濃鼠", "#E5E6E6", "Toilets coded 濃鼠", "facilities", ["B007", "B008", "B009", "B010", "B011", "B012", "B013", "B014"]],
  ["道白", "#C8C9CA", "Floor 0 walkways outside the gates", "free_area"],
  ["進入制限あり", null, "Restricted entry (KITTE)", "restricted"]
];

export function counts(overrides: Partial<ColorThemeCounts> = {}): ColorThemeCounts {
  return { rows: 0, recolor: 0, already_new: 0, empty: 0, unmapped: 0, too_wide: 0, undecodable: 0, ...overrides };
}

/** Every rule, with the rows each rewrote taken from `rows` by old value (the default rule only). */
export function colorThemeRules(rows: Record<string, number> = {}): ColorThemeRule[] {
  const seen = new Set<string>();
  return LINES.map(([old, oldHex, scope, area, categories], rule) => {
    const first = !seen.has(old);
    seen.add(old);
    const { name, spec, hex } = AREAS[area];
    return {
      rule,
      old,
      old_hex: oldHex,
      scope: { en: scope, ja: scope },
      categories: categories ?? null,
      area,
      area_name: name,
      value: name.ja,
      spec,
      hex,
      rows: first ? (rows[old] ?? 0) : 0,
      too_wide: 0
    };
  });
}

/** What `GET /api/color-theme` answers: every rule at zero. */
export function colorThemeReport(): ColorThemeReport {
  return { field: "color2", rules: colorThemeRules(), unmapped: [], layers: [], skipped: [], totals: counts() };
}

/** The survey numbers for JRTokyoSta_6677 (501 files, 10 Space layers, 2,164 rewrites). */
const TOKYO_ROWS: Record<string, number> = {
  白: 711,
  薄鼠: 612,
  薄空: 347,
  濃空: 229,
  トイレ: 113,
  ラチ外白: 70,
  道白: 20,
  濃鼠: 3,
  黄: 24,
  薄紅: 9,
  橙: 17,
  緑: 4,
  濃紅: 5
};

const TOKYO_LAYER_CHANGES = [400, 300, 250, 200, 214, 180, 170, 150, 150, 150];

export function tokyoInspection(): ColorThemeInspection {
  return {
    dataset: { name: "JRTokyoSta_6677", download_name: "JRTokyoSta_6677_new-colors.zip", files: 501 },
    theme: {
      field: "color2",
      rules: colorThemeRules(TOKYO_ROWS),
      unmapped: [],
      layers: TOKYO_LAYER_CHANGES.map((recolor, index) => ({
        id: `JRTokyoSta_6677.shp/JRTokyoSta_${index}_Space.dbf`,
        encoding: { codec: "utf-8", source: "cpg" },
        width: 254,
        counts: counts({ rows: recolor, recolor })
      })),
      skipped: [],
      totals: counts({ rows: 2164, recolor: 2164 })
    }
  };
}

/** The same station run through the tool a second time: every value is already new. */
export function rerunInspection(): ColorThemeInspection {
  const tokyo = tokyoInspection();
  return {
    dataset: tokyo.dataset,
    theme: {
      ...tokyo.theme,
      rules: colorThemeRules(),
      layers: tokyo.theme.layers.map((layer) => ({
        ...layer,
        counts: counts({ rows: layer.counts.rows, already_new: layer.counts.rows })
      })),
      totals: counts({ rows: 2164, already_new: 2164 })
    }
  };
}
