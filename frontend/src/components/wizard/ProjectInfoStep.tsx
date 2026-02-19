import { useEffect, useMemo, useState } from "react";

import type { ProjectWizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  project: ProjectWizardState | null;
  saving: boolean;
  onSave: (payload: ProjectWizardState) => void;
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
  "universit",
  "unspecified"
];


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


export function ProjectInfoStep({ project, saving, onSave }: Props) {
  const { t } = useUiLanguage();
  const [form, setForm] = useState<ProjectWizardState>(() => project ?? createDefaultProject());

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

  return (
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("Step 1: Project Info", "Step 1: プロジェクト情報")}</h2>
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={!canSave || saving}
          onClick={() => onSave(normalizeForSave(form))}
        >
          {saving ? t("Saving...", "保存中...") : t("Save Project Info", "プロジェクト情報を保存")}
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Project Name", "プロジェクト名")}</span>
          <input
            className="w-full rounded border px-2 py-1.5"
            value={form.project_name ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, project_name: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Language Tag", "言語タグ")}</span>
          <input
            className="w-full rounded border px-2 py-1.5"
            value={form.language}
            onChange={(event) => setForm((prev) => ({ ...prev, language: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Venue Name *", "会場名 *")}</span>
          <input
            className="w-full rounded border px-2 py-1.5"
            value={form.venue_name}
            onChange={(event) => setForm((prev) => ({ ...prev, venue_name: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Venue Category *", "会場カテゴリ *")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={form.venue_category}
            onChange={(event) => setForm((prev) => ({ ...prev, venue_category: event.target.value }))}
          >
            {VENUE_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Venue Restriction", "会場の制限")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={form.venue_restriction ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, venue_restriction: event.target.value || null }))}
          >
            <option value="">{t("None", "なし")}</option>
            <option value="employeesonly">employeesonly</option>
            <option value="restricted">restricted</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Venue Hours", "営業時間")}</span>
          <input
            className="w-full rounded border px-2 py-1.5"
            value={form.venue_hours ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, venue_hours: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Venue Phone", "電話番号")}</span>
          <input
            className="w-full rounded border px-2 py-1.5"
            value={form.venue_phone ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, venue_phone: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Venue Website", "Webサイト")}</span>
          <input
            className="w-full rounded border px-2 py-1.5"
            value={form.venue_website ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, venue_website: event.target.value }))}
          />
        </label>
      </div>

      <div className="mt-4 rounded border border-slate-200 p-3">
        <h3 className="mb-2 text-sm font-semibold">{t("Venue Address", "会場住所")}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Street Address", "住所")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.address ?? ""}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, address: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Unit/Suite", "部屋番号")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.unit ?? ""}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, unit: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Locality *", "市区町村 *")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.locality}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, locality: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Country *", "国 *")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.country}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, country: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Province / State", "都道府県 / 州")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.province ?? ""}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, province: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Postal Code", "郵便番号")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.postal_code ?? ""}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, postal_code: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Postal Code Extension", "郵便番号（拡張）")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.postal_code_ext ?? ""}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, postal_code_ext: event.target.value }
                }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Vanity Postal Code", "カスタム郵便番号")}</span>
            <input
              className="w-full rounded border px-2 py-1.5"
              value={form.address.postal_code_vanity ?? ""}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  address: { ...prev.address, postal_code_vanity: event.target.value }
                }))
              }
            />
          </label>
        </div>
      </div>
    </section>
  );
}
