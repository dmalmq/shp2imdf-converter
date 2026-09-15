import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GeocodeResultItem, ProjectWizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";
import { HoursEditor } from "./HoursEditor";
import { ProvinceSelect } from "./ProvinceSelect";
import { useRegisterSave } from "./wizardSave";


type Props = {
  project: ProjectWizardState | null;
  onSave: (payload: ProjectWizardState) => void;
  onSearchAddress: (query: string, language: string) => Promise<GeocodeResultItem[]>;
  onAutofillFromGeometry: (language: string) => Promise<GeocodeResultItem | null>;
};

const VENUE_CATEGORIES = [
  "airport",
  "airport.intl",
  "aquarium",
  "businesscampus",
  "casino",
  "communitycenter",
  "conventioncenter",
  "governmentfacility",
  "healthcarefacility",
  "hotel",
  "museum",
  "parkingfacility",
  "resort",
  "retailstore",
  "shoppingcenter",
  "stadium",
  "stripmall",
  "theater",
  "themepark",
  "trainstation",
  "transitstation",
  "university",
  "unspecified"
];


const NO_RESTRICTION = "__none__";


function createDefaultProject(): ProjectWizardState {
  return {
    project_name: "",
    venue_name: "",
    venue_category: "transitstation",
    language: "en",
    venue_restriction: null,
    venue_hours: null,
    venue_phone: null,
    venue_website: null,
    address: {
      address: "",
      unit: null,
      locality: "",
      province: null,
      country: "JP",
      postal_code: null,
      postal_code_ext: null,
      postal_code_vanity: null
    }
  };
}


function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}


function normalizeForSave(payload: ProjectWizardState): ProjectWizardState {
  return {
    ...payload,
    project_name: emptyToNull(payload.project_name ?? ""),
    venue_name: payload.venue_name.trim(),
    venue_category: payload.venue_category.trim(),
    language: payload.language.trim() || "en",
    venue_restriction: emptyToNull(payload.venue_restriction ?? ""),
    venue_hours: emptyToNull(payload.venue_hours ?? ""),
    venue_phone: emptyToNull(payload.venue_phone ?? ""),
    venue_website: emptyToNull(payload.venue_website ?? ""),
    address: {
      address: emptyToNull(payload.address.address ?? ""),
      unit: emptyToNull(payload.address.unit ?? ""),
      locality: payload.address.locality.trim(),
      province: emptyToNull(payload.address.province ?? ""),
      country: payload.address.country.trim(),
      postal_code: emptyToNull(payload.address.postal_code ?? ""),
      postal_code_ext: emptyToNull(payload.address.postal_code_ext ?? ""),
      postal_code_vanity: emptyToNull(payload.address.postal_code_vanity ?? "")
    }
  };
}


function applyGeocodeResult(project: ProjectWizardState, result: GeocodeResultItem): ProjectWizardState {
  return {
    ...project,
    address: {
      ...project.address,
      address: result.address.address ?? project.address.address,
      unit: result.address.unit ?? project.address.unit,
      locality: result.address.locality ?? project.address.locality,
      province: result.address.province ?? project.address.province,
      country: result.address.country ?? project.address.country,
      postal_code: result.address.postal_code ?? project.address.postal_code,
      postal_code_ext: result.address.postal_code_ext ?? project.address.postal_code_ext,
      postal_code_vanity: result.address.postal_code_vanity ?? project.address.postal_code_vanity
    }
  };
}


export function ProjectInfoStep({
  project,
  onSave,
  onSearchAddress,
  onAutofillFromGeometry
}: Props) {
  const { t } = useUiLanguage();
  const [form, setForm] = useState<ProjectWizardState>(() => project ?? createDefaultProject());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [autofillLoading, setAutofillLoading] = useState(false);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);

  useEffect(() => {
    setForm(project ?? createDefaultProject());
  }, [project]);

  const canSave = useMemo(
    () =>
      form.venue_name.trim().length > 0 &&
      form.venue_category.trim().length > 0 &&
      form.address.locality.trim().length > 0 &&
      form.address.country.trim().length > 0,
    [form]
  );

  const runAddressSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchStatus(null);
      return;
    }

    setSearchLoading(true);
    setSearchStatus(null);
    try {
      const results = await onSearchAddress(query, form.language.trim() || "en");
      setSearchResults(results);
      if (!results.length) {
        setSearchStatus(t("No address matches found.", "一致する住所が見つかりません。"));
      }
    } finally {
      setSearchLoading(false);
    }
  };

  const runGeometryAutofill = async () => {
    setAutofillLoading(true);
    setSearchStatus(null);
    try {
      const result = await onAutofillFromGeometry(form.language.trim() || "en");
      if (!result) {
        setSearchStatus(t("Could not infer an address from source geometry.", "図形データから住所を推定できませんでした。"));
        return;
      }
      setForm((previous) => applyGeocodeResult(previous, result));
      setSearchStatus(t("Address fields were filled from shape location.", "シェープ位置から住所項目を補完しました。"));
    } finally {
      setAutofillLoading(false);
    }
  };

  const selectAddressResult = (result: GeocodeResultItem) => {
    setForm((previous) => applyGeocodeResult(previous, result));
    setSearchStatus(t("Address fields updated from selected result.", "選択した結果で住所項目を更新しました。"));
  };

  useRegisterSave(() => onSave(normalizeForSave(form)), {
    canSave,
    blockedReason: t(
      "Venue name, category, locality and country are required",
      "会場名・カテゴリ・市区町村・国は必須です"
    )
  });

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("Venue Name", "会場名")} required>
            {(id) => (
              <Input
                id={id}
                required
                value={form.venue_name}
                onChange={(event) => setForm((prev) => ({ ...prev, venue_name: event.target.value }))}
              />
            )}
          </Field>
          <Field label={t("Venue Category", "会場カテゴリ")} required>
            {(id) => (
              <Select
                value={form.venue_category}
                onValueChange={(value) => setForm((prev) => ({ ...prev, venue_category: value }))}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VENUE_CATEGORIES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t("Project Name", "プロジェクト名")}>
            {(id) => (
              <Input
                id={id}
                value={form.project_name ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, project_name: event.target.value }))}
              />
            )}
          </Field>
          <Field
            label={t("Language Tag", "言語タグ")}
            hint={t("BCP 47, e.g. en or ja", "BCP 47（例：en、ja）")}
          >
            {(id) => (
              <Input
                id={id}
                value={form.language}
                onChange={(event) => setForm((prev) => ({ ...prev, language: event.target.value }))}
              />
            )}
          </Field>
        </div>

        {/* Everything below is optional metadata; it was interleaved with the
            required fields, so a first-time user read eight boxes before
            learning that half of them could stay empty. */}
        <details className="group mt-5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium leading-[18px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {t("Contact, hours and restrictions", "連絡先・営業時間・制限")}
          </summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label={t("Venue Phone", "電話番号")}>
              {(id) => (
                <Input
                  id={id}
                  value={form.venue_phone ?? ""}
                  onChange={(event) => setForm((prev) => ({ ...prev, venue_phone: event.target.value }))}
                  placeholder={t("e.g. +1-555-123-4567", "例：+81-3-1234-5678")}
                />
              )}
            </Field>
            <Field label={t("Venue Website", "Webサイト")}>
              {(id) => (
                <Input
                  id={id}
                  value={form.venue_website ?? ""}
                  onChange={(event) => setForm((prev) => ({ ...prev, venue_website: event.target.value }))}
                  placeholder="https://"
                />
              )}
            </Field>
            <Field label={t("Venue Restriction", "会場の制限")}>
              {(id) => (
                <Select
                  value={form.venue_restriction ?? NO_RESTRICTION}
                  onValueChange={(value) =>
                    setForm((prev) => ({
                      ...prev,
                      venue_restriction: value === NO_RESTRICTION ? null : value
                    }))
                  }
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_RESTRICTION}>{t("None", "なし")}</SelectItem>
                    <SelectItem value="employeesonly">employeesonly</SelectItem>
                    <SelectItem value="restricted">restricted</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <span className="text-[13px] font-medium leading-[18px] text-foreground">
                {t("Venue Hours", "営業時間")}
              </span>
              <HoursEditor
                value={form.venue_hours ?? null}
                onChange={(val) => setForm((prev) => ({ ...prev, venue_hours: val }))}
              />
            </div>
          </div>
        </details>
      </section>

      {/* Address search used to be a grey box inside a bordered box inside the
          step card - three frames deep for one input and two buttons. It is
          now simply the head of the address section it fills in. */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold leading-5 text-foreground">
            {t("Venue Address", "会場住所")}
          </h2>
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            {t(
              "Search for the venue to fill these in, or type them yourself.",
              "会場を検索して入力するか、手入力してください。"
            )}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            className="min-w-[16rem] flex-1"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runAddressSearch();
              }
            }}
            placeholder={t("Search by place or address", "地名または住所で検索")}
            aria-label={t("Address search", "住所検索")}
          />
          <Button
            variant="outline"
            disabled={searchLoading || autofillLoading}
            onClick={() => void runAddressSearch()}
          >
            {searchLoading ? t("Searching…", "検索中…") : t("Search", "検索")}
          </Button>
          <Button
            variant="ghost"
            disabled={searchLoading || autofillLoading}
            onClick={() => void runGeometryAutofill()}
          >
            {autofillLoading
              ? t("Locating…", "位置を確認中…")
              : t("Use shape location", "シェープ位置を使う")}
          </Button>
        </div>

        {searchStatus ? (
          <p className="mt-2 text-xs leading-4 text-muted-foreground">{searchStatus}</p>
        ) : null}

        {searchResults.length > 0 ? (
          <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-border">
            {searchResults.map((result, index) => (
              <button
                key={`${result.display_name}-${index}`}
                type="button"
                className="block w-full border-b border-border px-3 py-2 text-left text-xs leading-4 transition-colors last:border-b-0 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                onClick={() => selectAddressResult(result)}
              >
                <span className="block font-medium text-foreground">{result.display_name}</span>
                <span className="mt-0.5 block font-mono text-[11px] leading-[14px] text-muted-foreground">
                  {[result.address.locality, result.address.country, result.address.postal_code]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label={t("Street Address", "住所")}>
            {(id) => (
              <Input
                id={id}
                value={form.address.address ?? ""}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, address: event.target.value }
                  }))
                }
              />
            )}
          </Field>
          <Field label={t("Unit/Suite", "部屋番号")}>
            {(id) => (
              <Input
                id={id}
                value={form.address.unit ?? ""}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, unit: event.target.value }
                  }))
                }
              />
            )}
          </Field>
          <Field label={t("Locality", "市区町村")} required>
            {(id) => (
              <Input
                id={id}
                required
                value={form.address.locality}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, locality: event.target.value }
                  }))
                }
              />
            )}
          </Field>
          <Field
            label={t("Country", "国")}
            required
            hint={t("ISO 3166-1 alpha-2, e.g. JP", "ISO 3166-1 alpha-2（例：JP）")}
          >
            {(id) => (
              <Input
                id={id}
                required
                value={form.address.country}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, country: event.target.value }
                  }))
                }
              />
            )}
          </Field>
          <Field label={t("Province / State", "都道府県 / 州")}>
            {(id) => (
              <ProvinceSelect
                id={id}
                country={form.address.country}
                value={form.address.province}
                onChange={(province) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, province }
                  }))
                }
              />
            )}
          </Field>
          <Field label={t("Postal Code", "郵便番号")}>
            {(id) => (
              <Input
                id={id}
                value={form.address.postal_code ?? ""}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, postal_code: event.target.value }
                  }))
                }
              />
            )}
          </Field>
          <Field label={t("Postal Code Extension", "郵便番号（拡張）")}>
            {(id) => (
              <Input
                id={id}
                value={form.address.postal_code_ext ?? ""}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, postal_code_ext: event.target.value }
                  }))
                }
              />
            )}
          </Field>
          <Field label={t("Vanity Postal Code", "カスタム郵便番号")}>
            {(id) => (
              <Input
                id={id}
                value={form.address.postal_code_vanity ?? ""}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    address: { ...prev.address, postal_code_vanity: event.target.value }
                  }))
                }
              />
            )}
          </Field>
        </div>
      </section>
    </div>
  );
}
