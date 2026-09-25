import type { BuildingWizardState, ImportedFile, ProjectWizardState, WizardState } from "../api/client";
import type { Bilingual } from "../components/shell/stages";
import { LEVEL_REQUIRED_TYPES } from "./bringIn";

export type SectionId =
  | "project"
  | "project-info"
  | "building"
  | "footprint"
  | "levels"
  | "attributes"
  | "unit"
  | "opening"
  | "fixture"
  | "detail"
  | "summary";

export type SetUpSection = {
  id: SectionId;
  label: Bilingual;
  done: boolean;
  hidden?: boolean;
  children?: SetUpSection[];
};

/** A field of the venue form a checklist item can put the cursor in. */
export type ProjectField = "venue_name" | "venue_category" | "locality" | "country";

/** One line of "Before you generate": what, where it lives, and where Fix goes. */
export type ChecklistItem = {
  id: string;
  label: Bilingual;
  where: Bilingual | null;
  fix: SectionId | "bring-in";
  field?: ProjectField;
  done: boolean;
};

export type SetUpView = {
  sections: SetUpSection[];
  /** Missing items first, in form order. */
  checklist: ChecklistItem[];
  left: number;
  canGenerate: boolean;
  unitCodes: { mapped: number; unresolved: number };
};

export type SetUpInput = {
  files: ReadonlyArray<ImportedFile>;
  /** What the form shows: the draft if there is one, else the saved copy. */
  project: ProjectWizardState | null;
  buildings: ReadonlyArray<BuildingWizardState>;
  /** A buildings draft the server would refuse, so not saved. */
  buildingsHeld: boolean;
  wizard: WizardState | null;
};

const PROJECT_AND_VENUE: Bilingual = { en: "Project & venue", ja: "プロジェクト & 会場" };
const VENUE_ADDRESS: Bilingual = { en: "Venue address", ja: "会場住所" };
const LEVEL_MAPPING: Bilingual = { en: "Level mapping", ja: "レベル対応付け" };
const ATTRIBUTE_MAPPING: Bilingual = { en: "Attribute mapping", ja: "属性対応付け" };

function buildingsComplete({ files, project, buildings, buildingsHeld }: SetUpInput): boolean {
  const required = files.filter((file) => LEVEL_REQUIRED_TYPES.has(file.detected_type ?? ""));
  if (required.length === 0) return true;
  if (buildingsHeld || buildings.length === 0) return false;
  const assigned = new Set(buildings.flatMap((building) => building.file_stems));
  const venueName = project?.venue_name?.trim();
  return (
    required.every((file) => assigned.has(file.stem)) &&
    buildings.every((building) => Boolean(building.name?.trim() || venueName)) &&
    buildings.every(
      (building) =>
        building.address_mode !== "different_address" ||
        Boolean(building.address?.locality?.trim() && building.address?.country?.trim())
    )
  );
}

export function setUpView(input: SetUpInput): SetUpView {
  const { files, project, wizard } = input;
  const has = (type: string) => files.some((file) => file.detected_type === type);
  const venueName = Boolean(project?.venue_name.trim());
  const venueCategory = Boolean(project?.venue_category.trim());
  const locality = Boolean(project?.address.locality.trim());
  const country = Boolean(project?.address.country.trim());
  const projectComplete = venueName && venueCategory && locality && country;
  const buildings = buildingsComplete(input);
  const typed = files.every((file) => Boolean(file.detected_type));
  const levels = files
    .filter((file) => LEVEL_REQUIRED_TYPES.has(file.detected_type ?? ""))
    .every((file) => file.detected_level !== null);
  const unitColumn = !has("unit") || Boolean(wizard?.mappings.unit.code_column);

  const items: ChecklistItem[] = [
    { id: "venue-name", label: { en: "Venue name", ja: "会場名" }, where: PROJECT_AND_VENUE, fix: "project-info", field: "venue_name", done: venueName },
    { id: "venue-category", label: { en: "Venue category", ja: "会場カテゴリ" }, where: PROJECT_AND_VENUE, fix: "project-info", field: "venue_category", done: venueCategory },
    { id: "locality", label: { en: "Locality", ja: "市区町村" }, where: VENUE_ADDRESS, fix: "project-info", field: "locality", done: locality },
    { id: "country", label: { en: "Country", ja: "国" }, where: VENUE_ADDRESS, fix: "project-info", field: "country", done: country },
    { id: "buildings", label: { en: "Buildings", ja: "建物" }, where: PROJECT_AND_VENUE, fix: "building", done: buildings },
    { id: "file-types", label: { en: "Every file has a type", ja: "すべてのファイルに種類が決まっている" }, where: { en: "Bring in", ja: "取り込み" }, fix: "bring-in", done: typed },
    { id: "levels", label: LEVEL_MAPPING, where: null, fix: "levels", done: levels },
    ...(has("unit")
      ? [{ id: "unit-column", label: { en: "Unit code column", ja: "ユニットのコード列" }, where: ATTRIBUTE_MAPPING, fix: "unit" as const, done: unitColumn }]
      : [])
  ];
  const checklist = [...items.filter((item) => !item.done), ...items.filter((item) => item.done)];
  const left = items.filter((item) => !item.done).length;
  const canGenerate = left === 0;
  const preview = wizard?.mappings.unit.preview ?? [];

  return {
    sections: [
      {
        id: "project",
        label: PROJECT_AND_VENUE,
        done: projectComplete && buildings,
        children: [
          { id: "project-info", label: { en: "Venue info", ja: "会場情報" }, done: projectComplete },
          { id: "building", label: { en: "Buildings", ja: "建物" }, done: buildings },
          { id: "footprint", label: { en: "Footprint", ja: "フットプリント" }, done: true }
        ]
      },
      { id: "levels", label: LEVEL_MAPPING, done: levels },
      {
        id: "attributes",
        label: ATTRIBUTE_MAPPING,
        done: unitColumn,
        children: [
          { id: "unit", label: { en: "Unit mapping", ja: "ユニット対応付け" }, done: unitColumn, hidden: !has("unit") },
          { id: "opening", label: { en: "Opening mapping", ja: "開口部対応付け" }, done: true, hidden: !has("opening") },
          { id: "fixture", label: { en: "Fixture mapping", ja: "什器対応付け" }, done: true, hidden: !has("fixture") },
          { id: "detail", label: { en: "Detail mapping", ja: "詳細の設定" }, done: true, hidden: !has("detail") }
        ]
      },
      { id: "summary", label: { en: "Summary & generate", ja: "概要 & 生成" }, done: canGenerate }
    ],
    checklist,
    left,
    canGenerate,
    unitCodes: { mapped: preview.length, unresolved: preview.filter((row) => row.unresolved).length }
  };
}

/** An IMDF value with the words a colleague would use for it. */
export type CodedOption = { code: string; label: Bilingual };

export const VENUE_CATEGORIES: CodedOption[] = [
  { code: "airport", label: { en: "Airport", ja: "空港" } },
  { code: "airport.intl", label: { en: "International airport", ja: "国際空港" } },
  { code: "aquarium", label: { en: "Aquarium", ja: "水族館" } },
  { code: "businesscampus", label: { en: "Business campus", ja: "ビジネスキャンパス" } },
  { code: "casino", label: { en: "Casino", ja: "カジノ" } },
  { code: "communitycenter", label: { en: "Community centre", ja: "公民館" } },
  { code: "conventioncenter", label: { en: "Convention centre", ja: "コンベンションセンター" } },
  { code: "governmentfacility", label: { en: "Government facility", ja: "官公庁施設" } },
  { code: "healthcarefacility", label: { en: "Healthcare facility", ja: "医療施設" } },
  { code: "hotel", label: { en: "Hotel", ja: "ホテル" } },
  { code: "museum", label: { en: "Museum", ja: "博物館・美術館" } },
  { code: "parkingfacility", label: { en: "Parking facility", ja: "駐車場" } },
  { code: "resort", label: { en: "Resort", ja: "リゾート" } },
  { code: "retailstore", label: { en: "Retail store", ja: "小売店" } },
  { code: "shoppingcenter", label: { en: "Shopping centre", ja: "ショッピングセンター" } },
  { code: "stadium", label: { en: "Stadium", ja: "スタジアム" } },
  { code: "stripmall", label: { en: "Strip mall", ja: "ストリップモール" } },
  { code: "theater", label: { en: "Theatre", ja: "劇場" } },
  { code: "themepark", label: { en: "Theme park", ja: "テーマパーク" } },
  { code: "trainstation", label: { en: "Train station", ja: "鉄道駅" } },
  { code: "transitstation", label: { en: "Transit station", ja: "交通機関の駅" } },
  { code: "university", label: { en: "University", ja: "大学" } },
  { code: "unspecified", label: { en: "Unspecified", ja: "指定なし" } }
];

export const RESTRICTIONS: CodedOption[] = [
  { code: "employeesonly", label: { en: "Employees only", ja: "従業員のみ" } },
  { code: "restricted", label: { en: "Restricted", ja: "立入制限" } }
];

/** Languages offered for the venue; a stored tag outside the list is kept and shown as well. */
export const LANGUAGE_TAGS = ["ja", "en", "zh-Hans", "zh-Hant", "ko"];

export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** The name `Intl` gives a language tag or region code in the UI language, or the code itself. */
export function codeName(kind: "language" | "region", code: string, uiLanguage: "en" | "ja"): string {
  try {
    return new Intl.DisplayNames([uiLanguage], { type: kind, fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The canonical BCP 47 form of `input` ("zh-hant" → "zh-Hant"), or null if it is not a language tag. */
export function canonicalTag(input: string): string | null {
  const tag = input.trim();
  if (!tag) return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/** A stored country code as it is compared and shown: `"jp "` is `JP`. */
export function countryCode(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/** `options`, plus `current` if it is not one of them, so a stored value is never shown blank. */
export function withCurrent(options: ReadonlyArray<string>, current: string | null | undefined): string[] {
  const value = current?.trim();
  return value && !options.includes(value) ? [value, ...options] : [...options];
}
