import { useEffect, useMemo, useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui";
import type { ReviewFeature } from "./types";

/**
 * Facility metadata for datasets that ship no Site or Building layer.
 *
 * JR's opendata is levels and units only, and the IMDF-shapefile profile skips
 * the wizard, so the venue and building are synthesized as "Venue"/"Building"
 * with an empty address. Site.shp then exports name "Venue" with category A999
 * (不明・その他) — exactly the fields an ODC submission is judged on, and
 * nothing else in this profile ever asks for them.
 *
 * Categories are stored as spec codes; the exporter passes an `A\d{3}` value
 * through verbatim, so there is no table to keep in step.
 */

// 別表8.2.1 施設のカテゴリー (https://www.gsi.go.jp/common/000212584.pdf)
const VENUE_CATEGORY_CODES: Array<{ code: string; en: string; ja: string }> = [
  { code: "A001", en: "Transit station", ja: "駅" },
  { code: "A002", en: "Airport", ja: "空港" },
  { code: "A003", en: "Stadium, park, exercise facility", ja: "競技場・公園・運動施設" },
  { code: "A004", en: "Underpass, underground shopping area", ja: "地下道・地下街" },
  { code: "A005", en: "Convention center", ja: "コンベンションセンター" },
  { code: "A006", en: "Government facility", ja: "官公署" },
  { code: "A007", en: "Medical facility", ja: "医療施設" },
  { code: "A008", en: "Health and welfare facility", ja: "保健・福祉施設" },
  { code: "A009", en: "Community center", ja: "コミュニティセンター" },
  { code: "A010", en: "Hotel", ja: "ホテル" },
  { code: "A011", en: "Parking facility", ja: "駐車場" },
  { code: "A012", en: "University", ja: "大学" },
  { code: "A013", en: "Theater", ja: "劇場" },
  { code: "A014", en: "Aquarium", ja: "水族館" },
  { code: "A015", en: "Museum", ja: "美術館" },
  { code: "A016", en: "Other educational or cultural facility", ja: "その他の教育文化施設" },
  { code: "A017", en: "Retail store", ja: "商業施設" },
  { code: "A018", en: "Shopping center", ja: "ショッピングセンター" },
  { code: "A019", en: "Resort", ja: "行楽地" },
  { code: "A020", en: "Theme park", ja: "テーマパーク" },
  { code: "A021", en: "Casino", ja: "カジノ" },
  { code: "A022", en: "Other tourist facility", ja: "その他の観光施設" },
  { code: "A023", en: "Business campus", ja: "企業私有地" },
  { code: "A024", en: "Public toilet (standalone)", ja: "公共トイレ（単体）" },
  { code: "A999", en: "Unknown, other", ja: "不明・その他" }
];

export type AddressParts = {
  address: string | null;
  locality: string | null;
  province: string | null;
  country: string | null;
  postal_code: string | null;
};

type Props = {
  venue: ReviewFeature | null;
  building: ReviewFeature | null;
  address: ReviewFeature | null;
  language: string;
  onSave: (featureId: string, properties: Record<string, unknown>) => void;
  onRequestAutofill: () => Promise<AddressParts | null>;
};

type Draft = {
  venueName: string;
  category: string;
  hours: string;
  phone: string;
  website: string;
  buildingName: string;
  address: string;
  locality: string;
  province: string;
  country: string;
  postalCode: string;
};

function labelText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const found = Object.values(value as Record<string, unknown>).find((item) => typeof item === "string");
    return typeof found === "string" ? found : "";
  }
  return "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function seedDraft(venue: ReviewFeature | null, building: ReviewFeature | null, address: ReviewFeature | null): Draft {
  const venueProps = venue?.properties ?? {};
  const addressProps = address?.properties ?? {};
  return {
    venueName: labelText(venueProps.name),
    category: text(venueProps.category) === "unspecified" ? "" : text(venueProps.category).toUpperCase(),
    hours: text(venueProps.hours),
    phone: text(venueProps.phone),
    website: text(venueProps.website),
    buildingName: labelText(building?.properties?.name),
    address: text(addressProps.address),
    locality: text(addressProps.locality),
    province: text(addressProps.province),
    country: text(addressProps.country),
    postalCode: text(addressProps.postal_code)
  };
}

export function VenueDetailsPanel({ venue, building, address, language, onSave, onRequestAutofill }: Props) {
  const { t } = useUiLanguage();
  const seeded = useMemo(() => seedDraft(venue, building, address), [venue, building, address]);
  const [draft, setDraft] = useState<Draft>(seeded);
  const [autofilling, setAutofilling] = useState(false);
  const [expanded, setExpanded] = useState(
    () => seeded.venueName === "" || seeded.venueName === "Venue" || seeded.category === ""
  );

  useEffect(() => {
    setDraft(seeded);
  }, [seeded]);

  if (!venue) {
    return null;
  }

  const field = (key: keyof Draft, label: string, placeholder?: string) => (
    <label className="text-[11px] text-[var(--color-text-secondary)]">
      <span className="mb-0.5 block">{label}</span>
      <input
        className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-xs"
        value={draft[key]}
        placeholder={placeholder}
        onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
      />
    </label>
  );

  const save = () => {
    if (draft.venueName !== seeded.venueName || draft.category !== seeded.category) {
      const properties: Record<string, unknown> = {};
      if (draft.venueName !== seeded.venueName) {
        properties.name = { [language]: draft.venueName };
      }
      if (draft.category !== seeded.category) {
        properties.category = draft.category || "unspecified";
      }
      onSave(venue.id, properties);
    }
    const venueContact: Record<string, unknown> = {};
    if (draft.hours !== seeded.hours) venueContact.hours = draft.hours || null;
    if (draft.phone !== seeded.phone) venueContact.phone = draft.phone || null;
    if (draft.website !== seeded.website) venueContact.website = draft.website || null;
    if (Object.keys(venueContact).length > 0) {
      onSave(venue.id, venueContact);
    }
    if (building && draft.buildingName !== seeded.buildingName) {
      onSave(building.id, { name: { [language]: draft.buildingName } });
    }
    if (address) {
      const addressProps: Record<string, unknown> = {};
      if (draft.address !== seeded.address) addressProps.address = draft.address;
      if (draft.locality !== seeded.locality) addressProps.locality = draft.locality;
      if (draft.province !== seeded.province) addressProps.province = draft.province || null;
      if (draft.country !== seeded.country) addressProps.country = draft.country.toUpperCase();
      if (draft.postalCode !== seeded.postalCode) addressProps.postal_code = draft.postalCode || null;
      if (Object.keys(addressProps).length > 0) {
        onSave(address.id, addressProps);
      }
    }
  };

  const autofill = async () => {
    setAutofilling(true);
    try {
      const parts = await onRequestAutofill();
      if (parts) {
        setDraft((prev) => ({
          ...prev,
          address: parts.address ?? prev.address,
          locality: parts.locality ?? prev.locality,
          province: parts.province ?? prev.province,
          country: parts.country ?? prev.country,
          postalCode: parts.postal_code ?? prev.postalCode
        }));
      }
    } finally {
      setAutofilling(false);
    }
  };

  return (
    <div className="border-b border-[var(--color-border)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span>{expanded ? "▾" : "▸"}</span>
        <span>{t("Facility details", "施設情報")}</span>
        {draft.venueName === "" || draft.venueName === "Venue" || draft.category === "" ? (
          <span className="ml-auto rounded-[var(--radius-sm)] bg-[var(--color-error-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-error)]">
            {t("required", "未入力")}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="grid gap-2 px-3 pb-3">
          {field("venueName", t("Facility name", "施設の名称"), t("e.g. JR Shinjuku Station", "例: JR新宿駅"))}
          <label className="text-[11px] text-[var(--color-text-secondary)]">
            <span className="mb-0.5 block">{t("Facility category", "施設のカテゴリー")}</span>
            <select
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-xs"
              value={draft.category}
              onChange={(event) => setDraft((prev) => ({ ...prev, category: event.target.value }))}
            >
              <option value="">{t("(not set)", "（未設定）")}</option>
              {VENUE_CATEGORY_CODES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.code} {t(option.en, option.ja)}
                </option>
              ))}
            </select>
          </label>
          {building ? field("buildingName", t("Building name", "建物躯体の名称")) : null}
          {address ? (
            <>
              {field("postalCode", t("Postal code", "郵便番号"))}
              {field("province", t("Prefecture", "都道府県"))}
              {field("locality", t("City", "市区町村"))}
              {field("address", t("Address", "住所"))}
              {field("country", t("Country (ISO)", "国 (ISO)"))}
              <Button variant="secondary" size="sm" onClick={() => void autofill()} disabled={autofilling}>
                {autofilling ? t("Looking up...", "取得中...") : t("Fill address from geometry", "位置から住所を取得")}
              </Button>
            </>
          ) : null}
          {field("hours", t("Opening hours", "営業時間"), "Mo-Su 05:00-24:00")}
          {field("phone", t("Phone", "電話番号"), "+81-3-0000-0000")}
          {field("website", t("Website", "ウェブサイト"), "https://")}
          <Button size="sm" onClick={save}>
            {t("Save facility details", "施設情報を保存")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
