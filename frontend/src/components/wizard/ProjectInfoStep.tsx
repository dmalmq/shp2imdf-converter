import { ChevronRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { GeocodeResultItem, ProjectWizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  COUNTRY_CODES,
  LANGUAGE_TAGS,
  RESTRICTIONS,
  VENUE_CATEGORIES,
  canonicalTag,
  codeName,
  countryCode,
  withCurrent,
  type CodedOption
} from "../../lib/setUp";
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
import { SetUpCard } from "./SetUpCard";
import { ProvinceSelect } from "./ProvinceSelect";


type Props = {
  /** What the form shows: the unsaved draft if there is one, else the saved project. */
  project: ProjectWizardState | null;
  onChange: (next: ProjectWizardState) => void;
  onSearchAddress: (query: string, language: string) => Promise<GeocodeResultItem[]>;
  onAutofillFromGeometry: (language: string) => Promise<GeocodeResultItem | null>;
};


const NO_RESTRICTION = "__none__";
const OTHER_LANGUAGE = "__other__";


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


/** The fields IMDF requires, and so the ones the backend refuses to store without. */
export function isProjectComplete(project: ProjectWizardState | null | undefined): boolean {
  if (!project) return false;
  return Boolean(
    project.venue_name.trim() &&
      project.venue_category.trim() &&
      project.address.locality.trim() &&
      project.address.country.trim()
  );
}


export function normalizeProjectForSave(payload: ProjectWizardState): ProjectWizardState {
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
  onChange,
  onSearchAddress,
  onAutofillFromGeometry
}: Props) {
  const { t, uiLanguage } = useUiLanguage();
  const form = project ?? createDefaultProject();
  // Address search and autofill resolve after an await; reading the latest
  // value through a ref keeps a slow lookup from overwriting what was typed
  // while it ran.
  const latest = useRef(form);
  latest.current = form;
  const setForm = (update: (previous: ProjectWizardState) => ProjectWizardState) => {
    latest.current = update(latest.current);
    onChange(latest.current);
  };
  const setAddress = (patch: Partial<ProjectWizardState["address"]>) =>
    setForm((previous) => ({ ...previous, address: { ...previous.address, ...patch } }));
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [autofillLoading, setAutofillLoading] = useState(false);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(() =>
    Boolean(form.venue_phone || form.venue_website || form.venue_restriction || form.venue_hours)
  );
  const [moreOpen, setMoreOpen] = useState(() =>
    Boolean(form.address.unit || form.address.postal_code_ext || form.address.postal_code_vanity)
  );
  const [otherTag, setOtherTag] = useState<string | null>(null);
  const [otherInvalid, setOtherInvalid] = useState(false);
  const country = countryCode(form.address.country);
  const countries = useMemo(
    () =>
      withCurrent(COUNTRY_CODES, country)
        .map((code) => ({ code, name: codeName("region", code, uiLanguage) }))
        .sort((left, right) => left.name.localeCompare(right.name, uiLanguage)),
    [country, uiLanguage]
  );
  const labelOf = (options: CodedOption[], code: string) => {
    const option = options.find((item) => item.code === code);
    return option ? t(option.label.en, option.label.ja) : code;
  };

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

  return (
    <div className="flex flex-col gap-4">
      <SetUpCard title={t("Venue", "会場")}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("Venue name", "会場名")} required>
            {(id) => (
              <Input
                id={id}
                required
                data-field="venue_name"
                value={form.venue_name}
                onChange={(event) => setForm((previous) => ({ ...previous, venue_name: event.target.value }))}
              />
            )}
          </Field>
          <Field label={t("Venue category", "会場カテゴリ")} required code={form.venue_category || null}>
            {(id) => (
              <Select
                value={form.venue_category}
                onValueChange={(value) => setForm((previous) => ({ ...previous, venue_category: value }))}
              >
                <SelectTrigger id={id} data-field="venue_category">
                  <SelectValue placeholder={t("Choose…", "選択…")} />
                </SelectTrigger>
                <SelectContent>
                  {withCurrent(VENUE_CATEGORIES.map((item) => item.code), form.venue_category).map((code) => (
                    <SelectItem key={code} value={code}>
                      {labelOf(VENUE_CATEGORIES, code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t("Project name", "プロジェクト名")}>
            {(id) => (
              <Input
                id={id}
                value={form.project_name ?? ""}
                onChange={(event) => setForm((previous) => ({ ...previous, project_name: event.target.value }))}
              />
            )}
          </Field>
          <Field label={t("Language", "言語")} code={form.language || null}>
            {(id) => (
              <div className="flex flex-col gap-2">
                <Select
                  value={otherTag === null ? form.language : OTHER_LANGUAGE}
                  onValueChange={(value) => {
                    if (value === OTHER_LANGUAGE) {
                      setOtherTag("");
                      return;
                    }
                    setOtherTag(null);
                    setForm((previous) => ({ ...previous, language: value }));
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {withCurrent(LANGUAGE_TAGS, form.language).map((tag) => (
                      <SelectItem key={tag} value={tag}>
                        {codeName("language", tag, uiLanguage)}
                      </SelectItem>
                    ))}
                    <SelectItem value={OTHER_LANGUAGE}>{t("Other…", "その他…")}</SelectItem>
                  </SelectContent>
                </Select>
                {otherTag !== null ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const tag = canonicalTag(otherTag);
                      if (!tag) {
                        setOtherInvalid(true);
                        return;
                      }
                      setOtherTag(null);
                      setOtherInvalid(false);
                      setForm((previous) => ({ ...previous, language: tag }));
                    }}
                  >
                    <Input
                      autoFocus
                      className="font-mono"
                      aria-label={t("Language tag", "言語タグ")}
                      aria-invalid={otherInvalid || undefined}
                      placeholder="fr, pt-BR, zh-Hant-TW"
                      value={otherTag}
                      onChange={(event) => {
                        setOtherTag(event.target.value);
                        setOtherInvalid(false);
                      }}
                    />
                    <Button type="submit" variant="outline">
                      {t("Use", "使う")}
                    </Button>
                  </form>
                ) : null}
                {otherInvalid ? (
                  <p role="alert" className="text-xs text-destructive">
                    {t(
                      "That is not a language tag. Use a BCP 47 tag such as fr or pt-BR.",
                      "言語タグではありません。fr や pt-BR のような BCP 47 のタグを入力してください。"
                    )}
                  </p>
                ) : null}
              </div>
            )}
          </Field>
        </div>
      </SetUpCard>

      <details
        open={contactOpen}
        onToggle={(event) => setContactOpen(event.currentTarget.open)}
        className="group rounded-[14px] border border-border bg-card p-5"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-[15px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
          {t("Contact, hours and restrictions", "連絡先・営業時間・制限")}
        </summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label={t("Phone", "電話番号")}>
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                value={form.venue_phone ?? ""}
                onChange={(event) => setForm((previous) => ({ ...previous, venue_phone: event.target.value }))}
                placeholder="+81-3-1234-5678"
              />
            )}
          </Field>
          <Field label={t("Website", "Webサイト")}>
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                value={form.venue_website ?? ""}
                onChange={(event) => setForm((previous) => ({ ...previous, venue_website: event.target.value }))}
                placeholder="https://"
              />
            )}
          </Field>
          <Field label={t("Restriction", "会場の制限")} code={form.venue_restriction}>
            {(id) => (
              <Select
                value={form.venue_restriction ?? NO_RESTRICTION}
                onValueChange={(value) =>
                  setForm((previous) => ({ ...previous, venue_restriction: value === NO_RESTRICTION ? null : value }))
                }
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_RESTRICTION}>{t("None", "なし")}</SelectItem>
                  {withCurrent(RESTRICTIONS.map((item) => item.code), form.venue_restriction).map((code) => (
                    <SelectItem key={code} value={code}>
                      {labelOf(RESTRICTIONS, code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <HoursEditor
            value={form.venue_hours ?? null}
            onChange={(value) => setForm((previous) => ({ ...previous, venue_hours: value }))}
          />
        </div>
      </details>

      <SetUpCard
        title={t("Venue address", "会場住所")}
        intro={t(
          "Search for the venue to fill these in, or type them yourself.",
          "会場を検索して入力するか、手入力してください。"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
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
          <Field className="md:col-span-2" label={t("Street address", "住所")}>
            {(id) => (
              <Input id={id} value={form.address.address ?? ""} onChange={(event) => setAddress({ address: event.target.value })} />
            )}
          </Field>
          <Field label={t("Postal code", "郵便番号")}>
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                value={form.address.postal_code ?? ""}
                onChange={(event) => setAddress({ postal_code: event.target.value })}
              />
            )}
          </Field>
          <Field label={t("Locality", "市区町村")} required>
            {(id) => (
              <Input
                id={id}
                required
                data-field="locality"
                value={form.address.locality}
                onChange={(event) => setAddress({ locality: event.target.value })}
              />
            )}
          </Field>
          <Field label={t("Province / state", "都道府県 / 州")}>
            {(id) => (
              <ProvinceSelect
                id={id}
                country={form.address.country}
                value={form.address.province}
                onChange={(province) => setAddress({ province })}
              />
            )}
          </Field>
          <Field label={t("Country", "国")} required code={country || null}>
            {(id) => (
              <Select value={country} onValueChange={(next) => setAddress({ country: next })}>
                <SelectTrigger id={id} data-field="country">
                  <SelectValue placeholder={t("Choose…", "選択…")} />
                </SelectTrigger>
                <SelectContent>
                  {countries.map(({ code, name }) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>

        <details open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)} className="group mt-5">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 rounded-sm text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="font-medium text-foreground">{t("More address fields", "その他の住所項目")}</span>
            <span className="text-xs text-muted-foreground">
              {t(
                "Unit/suite · postal code extension · vanity postal code",
                "部屋番号・郵便番号（拡張）・カスタム郵便番号"
              )}
            </span>
          </summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label={t("Unit/suite", "部屋番号")}>
              {(id) => <Input id={id} value={form.address.unit ?? ""} onChange={(event) => setAddress({ unit: event.target.value })} />}
            </Field>
            <Field label={t("Postal code extension", "郵便番号（拡張）")}>
              {(id) => (
                <Input
                  id={id}
                  className="font-mono"
                  value={form.address.postal_code_ext ?? ""}
                  onChange={(event) => setAddress({ postal_code_ext: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("Vanity postal code", "カスタム郵便番号")}>
              {(id) => (
                <Input
                  id={id}
                  value={form.address.postal_code_vanity ?? ""}
                  onChange={(event) => setAddress({ postal_code_vanity: event.target.value })}
                />
              )}
            </Field>
          </div>
        </details>
      </SetUpCard>
    </div>
  );
}
