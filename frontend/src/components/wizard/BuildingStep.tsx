import { useMemo, useRef } from "react";

import type { AddressInput, BuildingWizardState } from "../../api/client";
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
import { ProvinceSelect } from "./ProvinceSelect";


type Props = {
  /** What the form shows: the unsaved draft if there is one, else the saved rows. */
  buildings: BuildingWizardState[];
  allFileStems: string[];
  venueName: string;
  venueAddress: AddressInput | null;
  onChange: (buildings: BuildingWizardState[]) => void;
};

const BUILDING_CATEGORIES = ["unspecified", "parking", "transit", "transit.bus", "transit.train"];

/** Radix Select has no empty-string value, so "no restriction" needs a sentinel. */
const NO_RESTRICTION = "__none__";

const EMPTY_ADDRESS: AddressInput = {
  address: "",
  unit: null,
  locality: "",
  province: null,
  country: "",
  postal_code: null,
  postal_code_ext: null,
  postal_code_vanity: null
};


function createDefaultBuilding(allFileStems: string[]): BuildingWizardState {
  return {
    id: "building-1",
    name: null,
    category: "unspecified",
    restriction: null,
    file_stems: allFileStems,
    address_mode: "same_as_venue",
    address: null,
    address_feature_id: null
  };
}


function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}


function normalizeAddress(address: AddressInput | null): AddressInput | null {
  if (!address) {
    return null;
  }
  return {
    address: emptyToNull(address.address ?? ""),
    unit: emptyToNull(address.unit ?? ""),
    locality: address.locality.trim(),
    province: emptyToNull(address.province ?? ""),
    country: address.country.trim(),
    postal_code: emptyToNull(address.postal_code ?? ""),
    postal_code_ext: emptyToNull(address.postal_code_ext ?? ""),
    postal_code_vanity: emptyToNull(address.postal_code_vanity ?? "")
  };
}


/**
 * Whether the backend would take these rows: every stem is a known file and
 * none is assigned twice. The stems box is free text, so a half-typed stem is
 * routine and has to be held back rather than sent.
 */
export function canSaveBuildings(buildings: BuildingWizardState[], allFileStems: string[]): boolean {
  const known = new Set(allFileStems);
  const seen = new Set<string>();
  for (const stem of buildings.flatMap((building) => building.file_stems)) {
    if (!known.has(stem) || seen.has(stem)) return false;
    seen.add(stem);
  }
  return true;
}


export function normalizeBuildingsForSave(buildings: BuildingWizardState[]): BuildingWizardState[] {
  return buildings.map((item) => ({
    ...item,
    name: emptyToNull(item.name ?? ""),
    category: item.category || "unspecified",
    restriction: emptyToNull(item.restriction ?? ""),
    file_stems: item.file_stems.filter((stem) => stem.trim().length > 0),
    address: item.address_mode === "different_address" ? normalizeAddress(item.address) : null
  }));
}


export function BuildingStep({ buildings, allFileStems, venueName, venueAddress, onChange }: Props) {
  const { t } = useUiLanguage();
  const rows = buildings.length ? buildings : [createDefaultBuilding(allFileStems)];
  const latest = useRef(rows);
  latest.current = rows;
  const setRows = (update: (previous: BuildingWizardState[]) => BuildingWizardState[]) => {
    latest.current = update(latest.current);
    onChange(latest.current);
  };

  const assignedCount = useMemo(
    () => rows.reduce((count, row) => count + row.file_stems.length, 0),
    [rows]
  );

  const patch = (index: number, changes: Partial<BuildingWizardState>) => {
    setRows((prev) => prev.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  };

  const patchAddress = (index: number, changes: Partial<AddressInput>) => {
    setRows((prev) =>
      prev.map((item, i) =>
        i === index && item.address ? { ...item, address: { ...item.address, ...changes } } : item
      )
    );
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs leading-4 text-muted-foreground">
          {t(
            `${assignedCount} files assigned. A building uses the venue address unless you give it its own.`,
            `割り当て済み ${assignedCount} 件。別住所を設定しない限り会場住所を使用します。`
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              {
                ...createDefaultBuilding([]),
                id: `building-${prev.length + 1}`,
                file_stems: []
              }
            ])
          }
        >
          {t("Add building", "建物を追加")}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((building, index) => (
          <div key={building.id} className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                {building.id}
              </h3>
              {rows.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                >
                  {t("Remove", "削除")}
                </Button>
              ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("Building Name", "建物名")}>
                {(id) => (
                  <Input
                    id={id}
                    placeholder={venueName || ""}
                    value={building.name ?? ""}
                    onChange={(event) => patch(index, { name: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t("Category", "カテゴリ")}>
                {(id) => (
                  <Select
                    value={building.category}
                    onValueChange={(value) => patch(index, { category: value })}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BUILDING_CATEGORIES.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={t("Restriction", "制限")}>
                {(id) => (
                  <Select
                    value={building.restriction ?? NO_RESTRICTION}
                    onValueChange={(value) =>
                      patch(index, { restriction: value === NO_RESTRICTION ? null : value })
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
              <Field label={t("Address", "住所")}>
                {(id) => (
                  <Select
                    value={building.address_mode}
                    onValueChange={(value) =>
                      patch(index, {
                        address_mode: value as BuildingWizardState["address_mode"],
                        address:
                          value === "different_address"
                            ? rows[index].address ?? { ...(venueAddress ?? EMPTY_ADDRESS) }
                            : null
                      })
                    }
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="same_as_venue">
                        {t("Same as venue", "会場住所と同じ")}
                      </SelectItem>
                      <SelectItem value="different_address">
                        {t("Its own address", "建物ごとに別住所")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field
                className="md:col-span-2"
                label={t("Assigned files", "割り当てファイル")}
                hint={t("Comma-separated file stems", "ファイル名をカンマ区切りで")}
              >
                {(id) => (
                  <Input
                    id={id}
                    className="font-mono text-xs"
                    value={building.file_stems.join(",")}
                    placeholder={allFileStems.join(",")}
                    onChange={(event) =>
                      patch(index, {
                        file_stems: event.target.value
                          .split(",")
                          .map((token) => token.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                )}
              </Field>
            </div>

            {building.address_mode === "different_address" && building.address ? (
              <div className="mt-4 grid gap-4 rounded-lg border border-border bg-muted/40 p-4 md:grid-cols-2">
                <Field label={t("Street Address", "住所")}>
                  {(id) => (
                    <Input
                      id={id}
                      value={building.address?.address ?? ""}
                      onChange={(event) => patchAddress(index, { address: event.target.value })}
                    />
                  )}
                </Field>
                <Field label={t("Locality", "市区町村")}>
                  {(id) => (
                    <Input
                      id={id}
                      value={building.address?.locality ?? ""}
                      onChange={(event) => patchAddress(index, { locality: event.target.value })}
                    />
                  )}
                </Field>
                <Field label={t("Country", "国")}>
                  {(id) => (
                    <Input
                      id={id}
                      value={building.address?.country ?? ""}
                      onChange={(event) => patchAddress(index, { country: event.target.value })}
                    />
                  )}
                </Field>
                <Field label={t("Province / State", "都道府県 / 州")}>
                  {(id) => (
                    <ProvinceSelect
                      id={id}
                      country={building.address?.country ?? ""}
                      value={building.address?.province ?? null}
                      onChange={(province) => patchAddress(index, { province })}
                    />
                  )}
                </Field>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
