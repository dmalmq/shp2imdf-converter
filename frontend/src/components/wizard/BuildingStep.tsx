import { useEffect, useMemo, useState } from "react";

import type { AddressInput, BuildingWizardState } from "../../api/client";


type Props = {
  buildings: BuildingWizardState[];
  allFileStems: string[];
  venueAddress: AddressInput | null;
  saving: boolean;
  onSave: (buildings: BuildingWizardState[]) => void;
};

const BUILDING_CATEGORIES = ["unspecified", "parking", "transit", "transit.bus", "transit.train"];


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


function normalizeForSave(buildings: BuildingWizardState[]): BuildingWizardState[] {
  return buildings.map((item) => ({
    ...item,
    name: emptyToNull(item.name ?? ""),
    category: item.category || "unspecified",
    restriction: emptyToNull(item.restriction ?? ""),
    file_stems: item.file_stems.filter((stem) => stem.trim().length > 0),
    address: item.address_mode === "different_address" ? normalizeAddress(item.address) : null
  }));
}


export function BuildingStep({ buildings, allFileStems, venueAddress, saving, onSave }: Props) {
  const [rows, setRows] = useState<BuildingWizardState[]>(
    () => (buildings.length ? buildings : [createDefaultBuilding(allFileStems)])
  );

  useEffect(() => {
    if (buildings.length) {
      setRows(buildings);
      return;
    }
    setRows([createDefaultBuilding(allFileStems)]);
  }, [allFileStems, buildings]);

  const assignedCount = useMemo(
    () => rows.reduce((count, row) => count + row.file_stems.length, 0),
    [rows]
  );

  return (
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Step 4: Building Assignment</h2>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
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
            Add Building
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
            disabled={saving}
            onClick={() => onSave(normalizeForSave(rows))}
          >
            {saving ? "Saving..." : "Save Buildings"}
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-600">
        Assigned file links: {assignedCount}. Building address defaults to venue address unless set to different.
      </p>

      <div className="space-y-3">
        {rows.map((building, index) => (
          <div key={building.id} className="rounded border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{building.id}</h3>
              {rows.length > 1 && (
                <button
                  type="button"
                  className="rounded border border-red-300 px-2 py-1 text-xs text-red-700"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">Building Name</span>
                <input
                  className="w-full rounded border px-2 py-1.5"
                  value={building.name ?? ""}
                  onChange={(event) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              name: event.target.value
                            }
                          : item
                      )
                    )
                  }
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">Category</span>
                <select
                  className="w-full rounded border px-2 py-1.5"
                  value={building.category}
                  onChange={(event) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              category: event.target.value
                            }
                          : item
                      )
                    )
                  }
                >
                  {BUILDING_CATEGORIES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">Restriction</span>
                <select
                  className="w-full rounded border px-2 py-1.5"
                  value={building.restriction ?? ""}
                  onChange={(event) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              restriction: event.target.value || null
                            }
                          : item
                      )
                    )
                  }
                >
                  <option value="">None</option>
                  <option value="employeesonly">employeesonly</option>
                  <option value="restricted">restricted</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">Address Mode</span>
                <select
                  className="w-full rounded border px-2 py-1.5"
                  value={building.address_mode}
                  onChange={(event) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              address_mode: event.target.value as BuildingWizardState["address_mode"],
                              address:
                                event.target.value === "different_address"
                                  ? item.address ?? {
                                      ...(venueAddress ?? {
                                        address: "",
                                        unit: null,
                                        locality: "",
                                        province: null,
                                        country: "",
                                        postal_code: null,
                                        postal_code_ext: null,
                                        postal_code_vanity: null
                                      })
                                    }
                                  : null
                            }
                          : item
                      )
                    )
                  }
                >
                  <option value="same_as_venue">Same as venue</option>
                  <option value="different_address">Different address</option>
                </select>
              </label>
              <label className="text-sm md:col-span-2">
                <span className="mb-1 block text-slate-600">Assigned Files (comma-separated stems)</span>
                <input
                  className="w-full rounded border px-2 py-1.5 font-mono text-xs"
                  value={building.file_stems.join(",")}
                  onChange={(event) =>
                    setRows((prev) =>
                      prev.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              file_stems: event.target.value
                                .split(",")
                                .map((token) => token.trim())
                                .filter(Boolean)
                            }
                          : item
                      )
                    )
                  }
                  placeholder={allFileStems.join(",")}
                />
              </label>
            </div>

            {building.address_mode === "different_address" && building.address && (
              <div className="mt-3 grid gap-3 rounded border border-slate-200 p-3 md:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-slate-600">Street Address</span>
                  <input
                    className="w-full rounded border px-2 py-1.5"
                    value={building.address.address ?? ""}
                    onChange={(event) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === index && item.address
                            ? {
                                ...item,
                                address: { ...item.address, address: event.target.value }
                              }
                            : item
                        )
                      )
                    }
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-slate-600">Locality</span>
                  <input
                    className="w-full rounded border px-2 py-1.5"
                    value={building.address.locality}
                    onChange={(event) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === index && item.address
                            ? {
                                ...item,
                                address: { ...item.address, locality: event.target.value }
                              }
                            : item
                        )
                      )
                    }
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-slate-600">Country</span>
                  <input
                    className="w-full rounded border px-2 py-1.5"
                    value={building.address.country}
                    onChange={(event) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === index && item.address
                            ? {
                                ...item,
                                address: { ...item.address, country: event.target.value }
                              }
                            : item
                        )
                      )
                    }
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-slate-600">Province</span>
                  <input
                    className="w-full rounded border px-2 py-1.5"
                    value={building.address.province ?? ""}
                    onChange={(event) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === index && item.address
                            ? {
                                ...item,
                                address: { ...item.address, province: event.target.value }
                              }
                            : item
                        )
                      )
                    }
                  />
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
