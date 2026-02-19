import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  autofixSession,
  deleteSessionFeature,
  exportSessionArchive,
  fetchSessionFeatures,
  generateSessionDraft,
  patchSessionFeature,
  patchSessionFeaturesBulk,
  validateSession,
  type ValidationIssue,
  type ValidationResponse
} from "../api/client";
import { ErrorBoundary } from "../components/shared/ErrorBoundary";
import { FilterBar } from "../components/review/FilterBar";
import { LayerTree } from "../components/review/LayerTree";
import { MapPanel } from "../components/review/MapPanel";
import { PropertiesPanel } from "../components/review/PropertiesPanel";
import { TablePanel } from "../components/review/TablePanel";
import { type ReviewFeature, featureName } from "../components/review/types";
import { useAppStore } from "../store/useAppStore";


function normalizeFeature(item: Record<string, unknown>): ReviewFeature | null {
  if (typeof item.id !== "string" || typeof item.feature_type !== "string") {
    return null;
  }
  const properties = item.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return null;
  }
  let geometry: ReviewFeature["geometry"] = null;
  if (item.geometry && typeof item.geometry === "object" && !Array.isArray(item.geometry)) {
    const candidate = item.geometry as { type?: unknown; coordinates?: unknown };
    if (typeof candidate.type === "string") {
      geometry = {
        type: candidate.type,
        coordinates: candidate.coordinates
      };
    }
  }
  return {
    type: String(item.type ?? "Feature"),
    id: item.id,
    feature_type: item.feature_type,
    geometry,
    properties: properties as Record<string, unknown>
  };
}


function levelLabel(feature: ReviewFeature): string {
  const shortName = feature.properties.short_name;
  if (shortName && typeof shortName === "object" && !Array.isArray(shortName)) {
    const value = Object.values(shortName).find((item) => typeof item === "string");
    if (typeof value === "string") {
      return value;
    }
  }
  const name = feature.properties.name;
  if (name && typeof name === "object" && !Array.isArray(name)) {
    const value = Object.values(name).find((item) => typeof item === "string");
    if (typeof value === "string") {
      return value;
    }
  }
  const ordinal = feature.properties.ordinal;
  if (typeof ordinal === "number") {
    return `Ordinal ${ordinal}`;
  }
  return feature.id.slice(0, 8);
}


function featureLevelId(feature: ReviewFeature): string | null {
  if (feature.feature_type === "level") {
    return feature.id;
  }
  const levelId = feature.properties.level_id;
  return typeof levelId === "string" ? levelId : null;
}


function applyFilters(features: ReviewFeature[], filters: Record<string, string | undefined>): ReviewFeature[] {
  const query = (filters.search ?? "").trim().toLowerCase();
  return features.filter((feature) => {
    if (filters.type && feature.feature_type !== filters.type) {
      return false;
    }
    if (filters.level) {
      const levelId = featureLevelId(feature);
      if (levelId !== filters.level) {
        return false;
      }
    }
    if (filters.category) {
      const category = feature.properties.category;
      if (typeof category !== "string" || category !== filters.category) {
        return false;
      }
    }
    if (filters.status) {
      const status = feature.properties.status;
      if (typeof status !== "string" || status !== filters.status) {
        return false;
      }
    }
    if (!query) {
      return true;
    }
    const name = featureName(feature).toLowerCase();
    const metadata = JSON.stringify(feature.properties.metadata ?? "").toLowerCase();
    return (
      feature.id.toLowerCase().includes(query) ||
      feature.feature_type.toLowerCase().includes(query) ||
      name.includes(query) ||
      metadata.includes(query)
    );
  });
}


export function ReviewPage() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId);
  const wizardState = useAppStore((state) => state.wizardState);
  const selectedFeatureIds = useAppStore((state) => state.selectedFeatureIds);
  const setSelectedFeatureIds = useAppStore((state) => state.setSelectedFeatureIds);
  const toggleSelectedFeatureId = useAppStore((state) => state.toggleSelectedFeatureId);
  const clearSelectedFeatureIds = useAppStore((state) => state.clearSelectedFeatureIds);
  const filters = useAppStore((state) => state.filters);
  const setFilters = useAppStore((state) => state.setFilters);
  const setValidationResults = useAppStore((state) => state.setValidationResults);
  const layerVisibility = useAppStore((state) => state.layerVisibility);
  const setLayerVisibility = useAppStore((state) => state.setLayerVisibility);
  const pushEditHistory = useAppStore((state) => state.pushEditHistory);
  const popEditHistory = useAppStore((state) => state.popEditHistory);
  const [features, setFeatures] = useState<ReviewFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapLevelFilter, setMapLevelFilter] = useState("");
  const [bulkLevel, setBulkLevel] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [mergeName, setMergeName] = useState("");
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [overlayVisibility, setOverlayVisibility] = useState<Record<string, boolean>>({
    errors: true,
    warnings: true,
    overlaps: true
  });
  const [validating, setValidating] = useState(false);
  const [autofixing, setAutofixing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      navigate("/");
      return;
    }
    if (Object.keys(layerVisibility).length === 0) {
      setLayerVisibility({
        venue: true,
        footprint: true,
        level: true,
        unit: true,
        opening: true,
        fixture: true,
        detail: true
      });
    }
  }, [layerVisibility, navigate, sessionId, setLayerVisibility]);

  const loadFeatures = async () => {
    if (!sessionId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let response = await fetchSessionFeatures(sessionId);
      let rows = (response.features as Record<string, unknown>[])
        .map((item) => normalizeFeature(item))
        .filter((item): item is ReviewFeature => item !== null);
      if (!rows.some((item) => item.feature_type === "level")) {
        await generateSessionDraft(sessionId);
        response = await fetchSessionFeatures(sessionId);
        rows = (response.features as Record<string, unknown>[])
          .map((item) => normalizeFeature(item))
          .filter((item): item is ReviewFeature => item !== null);
      }
      setFeatures(rows);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to load review data";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFeatures();
  }, [sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";
      if (!isUndo) {
        return;
      }
      event.preventDefault();
      if (!sessionId) {
        return;
      }
      const popped = popEditHistory();
      if (!popped) {
        return;
      }
      const featureId = popped.featureId;
      const previousProperties = popped.previousProperties;
      if (typeof featureId !== "string" || !previousProperties || typeof previousProperties !== "object") {
        return;
      }
      void patchSessionFeature(sessionId, featureId, {
        properties: previousProperties as Record<string, unknown>
      }).then((updated) => {
        setFeatures((prev) =>
          prev.map((item) =>
            item.id === updated.id
              ? {
                  type: updated.type,
                  id: updated.id,
                  feature_type: updated.feature_type,
                  geometry: updated.geometry as { type: string; coordinates: unknown } | null,
                  properties: updated.properties as Record<string, unknown>
                }
              : item
          )
        );
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [popEditHistory, sessionId]);

  const levelOptions = useMemo(() => {
    return features
      .filter((item) => item.feature_type === "level")
      .map((item) => ({ id: item.id, label: levelLabel(item) }));
  }, [features]);

  const addressOptions = useMemo(() => {
    return features
      .filter((item) => item.feature_type === "address")
      .map((item) => ({
        id: item.id,
        label: typeof item.properties.address === "string" ? item.properties.address : item.id.slice(0, 8)
      }));
  }, [features]);

  const featureTypes = useMemo(
    () =>
      [...new Set(features.map((item) => item.feature_type))]
        .sort((a, b) => a.localeCompare(b)),
    [features]
  );

  const categories = useMemo(() => {
    const collected = new Set<string>();
    features.forEach((feature) => {
      const category = feature.properties.category;
      if (typeof category === "string" && category.trim()) {
        collected.add(category);
      }
    });
    return [...collected].sort((a, b) => a.localeCompare(b));
  }, [features]);

  const filteredFeatures = useMemo(() => applyFilters(features, filters), [features, filters]);

  const selectedFeature = useMemo(() => {
    if (selectedFeatureIds.length === 0) {
      return null;
    }
    return features.find((item) => item.id === selectedFeatureIds[0]) ?? null;
  }, [features, selectedFeatureIds]);

  const saveFeatureProperties = async (featureId: string, properties: Record<string, unknown>) => {
    if (!sessionId) {
      return;
    }
    const previous = features.find((item) => item.id === featureId);
    if (!previous) {
      return;
    }
    pushEditHistory({
      featureId,
      previousProperties: previous.properties
    });
    const updated = await patchSessionFeature(sessionId, featureId, { properties });
    setFeatures((prev) =>
      prev.map((item) =>
        item.id === updated.id
          ? {
              type: updated.type,
              id: updated.id,
              feature_type: updated.feature_type,
              geometry: updated.geometry as { type: string; coordinates: unknown } | null,
              properties: updated.properties as Record<string, unknown>
            }
          : item
      )
    );
  };

  const deleteFeature = async (featureId: string) => {
    if (!sessionId) {
      return;
    }
    if (!window.confirm("Delete this feature?")) {
      return;
    }
    await deleteSessionFeature(sessionId, featureId);
    setFeatures((prev) => prev.filter((item) => item.id !== featureId));
    setSelectedFeatureIds(selectedFeatureIds.filter((id) => id !== featureId));
  };

  const applyBulkLevel = async () => {
    if (!sessionId || !bulkLevel || selectedFeatureIds.length === 0) {
      return;
    }
    await patchSessionFeaturesBulk(sessionId, {
      feature_ids: selectedFeatureIds,
      action: "patch",
      properties: {
        level_id: bulkLevel
      }
    });
    await loadFeatures();
  };

  const applyBulkCategory = async () => {
    if (!sessionId || !bulkCategory || selectedFeatureIds.length === 0) {
      return;
    }
    await patchSessionFeaturesBulk(sessionId, {
      feature_ids: selectedFeatureIds,
      action: "patch",
      properties: {
        category: bulkCategory
      }
    });
    await loadFeatures();
  };

  const mergeSelectedUnits = async () => {
    if (!sessionId || selectedFeatureIds.length < 2) {
      return;
    }
    await patchSessionFeaturesBulk(sessionId, {
      feature_ids: selectedFeatureIds,
      action: "merge_units",
      merge_name: mergeName || null
    });
    clearSelectedFeatureIds();
    await loadFeatures();
  };

  const deleteSelected = async () => {
    if (!sessionId || selectedFeatureIds.length === 0) {
      return;
    }
    if (!window.confirm(`Delete ${selectedFeatureIds.length} selected features?`)) {
      return;
    }
    await patchSessionFeaturesBulk(sessionId, {
      feature_ids: selectedFeatureIds,
      action: "delete"
    });
    clearSelectedFeatureIds();
    await loadFeatures();
  };

  const backToWizard = () => {
    if (!window.confirm("Return to wizard? Manual review edits may be replaced when you regenerate.")) {
      return;
    }
    navigate("/wizard");
  };

  const allValidationIssues = useMemo(() => {
    if (!validation) {
      return [] as ValidationIssue[];
    }
    return [...validation.errors, ...validation.warnings];
  }, [validation]);

  const issuesByFeature = useMemo(() => {
    const grouped = new Map<string, ValidationIssue[]>();
    allValidationIssues.forEach((issue) => {
      if (!issue.feature_id) {
        return;
      }
      grouped.set(issue.feature_id, [...(grouped.get(issue.feature_id) ?? []), issue]);
    });
    return grouped;
  }, [allValidationIssues]);

  const selectedFeatureIssues = useMemo(() => {
    if (!selectedFeature) {
      return [] as ValidationIssue[];
    }
    return issuesByFeature.get(selectedFeature.id) ?? [];
  }, [issuesByFeature, selectedFeature]);

  const applyPostValidationState = (next: ValidationResponse) => {
    setValidation(next);
    setValidationResults({
      errors: next.summary.error_count,
      warnings: next.summary.warning_count
    });
    if (next.summary.error_count > 0) {
      setFilters({ ...filters, status: "error" });
    } else if (next.summary.warning_count > 0) {
      setFilters({ ...filters, status: "warning" });
    } else {
      setFilters({ ...filters, status: undefined });
    }
  };

  const runValidation = async (): Promise<ValidationResponse | null> => {
    if (!sessionId) {
      return null;
    }
    setValidating(true);
    setError(null);
    try {
      const response = await validateSession(sessionId);
      applyPostValidationState(response);
      await loadFeatures();
      return response;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Validation failed";
      setError(message);
      return null;
    } finally {
      setValidating(false);
    }
  };

  const runAutofix = async (applyPrompted = false) => {
    if (!sessionId) {
      return;
    }
    setAutofixing(true);
    setError(null);
    try {
      const response = await autofixSession(sessionId, applyPrompted);
      if (!applyPrompted && response.total_requiring_confirmation > 0) {
        const confirmed = window.confirm(
          `${response.total_requiring_confirmation} destructive fixes require confirmation. Apply them now?`
        );
        if (confirmed) {
          const confirmedResponse = await autofixSession(sessionId, true);
          applyPostValidationState(confirmedResponse.revalidation);
        } else {
          applyPostValidationState(response.revalidation);
        }
      } else {
        applyPostValidationState(response.revalidation);
      }
      await loadFeatures();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Auto-fix failed";
      setError(message);
    } finally {
      setAutofixing(false);
    }
  };

  const openExportDialog = async () => {
    const validationResult = await runValidation();
    if (!validationResult) {
      return;
    }
    if (validationResult.summary.error_count > 0) {
      setError("Export is blocked until all validation errors are resolved.");
      return;
    }
    setExportDialogOpen(true);
  };

  const downloadExport = async () => {
    if (!sessionId) {
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const response = await exportSessionArchive(sessionId);
      const url = window.URL.createObjectURL(response.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setExportDialogOpen(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Export failed";
      setError(message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1700px] flex-col gap-4 px-6 py-5">
      <div className="flex items-center justify-between rounded border bg-white px-4 py-3">
        <div>
          <h1 className="text-2xl font-semibold">Review</h1>
          <p className="text-sm text-slate-600">Session: {sessionId ?? "None"}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={backToWizard}>
            ← Back to Wizard
          </button>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => void runValidation()}
            disabled={validating || loading}
          >
            {validating ? "Validating..." : "Validate"}
          </button>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => void openExportDialog()}
            disabled={exporting || validating || loading}
          >
            {exporting ? "Exporting..." : "Export"}
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <section className="space-y-3">
          <LayerTree
            layerVisibility={layerVisibility}
            levelFilter={mapLevelFilter}
            levelOptions={levelOptions}
            validationLoaded={validation !== null}
            overlayVisibility={overlayVisibility}
            onLayerVisibilityChange={setLayerVisibility}
            onLevelFilterChange={setMapLevelFilter}
            onOverlayVisibilityChange={setOverlayVisibility}
          />
          {loading ? (
            <div className="rounded border bg-white p-4 text-sm text-slate-600">Loading map...</div>
          ) : (
            <ErrorBoundary>
              <MapPanel
                features={features}
                selectedFeatureIds={selectedFeatureIds}
                layerVisibility={layerVisibility}
                validationIssues={allValidationIssues}
                overlayVisibility={overlayVisibility}
                levelFilter={mapLevelFilter}
                onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
              />
            </ErrorBoundary>
          )}
        </section>

        <section className="space-y-3">
          <FilterBar
            filters={filters}
            featureTypes={featureTypes}
            levels={levelOptions}
            categories={categories}
            onChange={(next) => setFilters(next)}
          />

          <div className="rounded border bg-white p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span>Selected: {selectedFeatureIds.length}</span>
              <select
                className="rounded border px-2 py-1"
                value={bulkLevel}
                onChange={(event) => setBulkLevel(event.target.value)}
              >
                <option value="">Reassign level...</option>
                {levelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button type="button" className="rounded border px-2 py-1" onClick={() => void applyBulkLevel()}>
                Apply Level
              </button>
              <input
                className="rounded border px-2 py-1"
                placeholder="Category..."
                value={bulkCategory}
                onChange={(event) => setBulkCategory(event.target.value)}
              />
              <button type="button" className="rounded border px-2 py-1" onClick={() => void applyBulkCategory()}>
                Apply Category
              </button>
              <input
                className="rounded border px-2 py-1"
                placeholder="Merge name"
                value={mergeName}
                onChange={(event) => setMergeName(event.target.value)}
              />
              <button type="button" className="rounded border px-2 py-1" onClick={() => void mergeSelectedUnits()}>
                Merge Units
              </button>
              <button
                type="button"
                className="rounded border border-red-300 px-2 py-1 text-red-700"
                onClick={() => void deleteSelected()}
              >
                Delete Selected
              </button>
            </div>
          </div>

          {loading ? (
            <div className="rounded border bg-white p-4 text-sm text-slate-600">Loading table...</div>
          ) : (
            <TablePanel
              features={filteredFeatures}
              selectedFeatureIds={selectedFeatureIds}
              onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
            />
          )}

          <PropertiesPanel
            feature={selectedFeature}
            language={wizardState?.project?.language ?? "en"}
            levelOptions={levelOptions}
            addressOptions={addressOptions}
            validationIssues={selectedFeatureIssues}
            autoFixing={autofixing}
            onSave={(featureId, properties) => void saveFeatureProperties(featureId, properties)}
            onDelete={(featureId) => void deleteFeature(featureId)}
            onAutoFixSafe={() => void runAutofix(false)}
          />
        </section>
      </div>

      {validation ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border bg-white px-4 py-3 text-sm">
          <div>
            Validation: {validation.summary.error_count} errors · {validation.summary.warning_count} warnings ·{" "}
            {validation.summary.auto_fixable_count} auto-fixable
          </div>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-xs"
            onClick={() => void runAutofix(false)}
            disabled={autofixing}
          >
            {autofixing ? "Applying Auto-fix..." : "Run Auto-fix"}
          </button>
        </div>
      ) : null}

      {exportDialogOpen && validation ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/35 p-4">
          <div className="w-full max-w-xl rounded border bg-white p-4 shadow-lg">
            <h3 className="text-lg font-semibold">Export IMDF</h3>
            <p className="mt-1 text-sm text-slate-600">
              {validation.summary.total_features} features will be exported.
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Validation: {validation.summary.error_count} errors · {validation.summary.warning_count} warnings
            </p>
            {validation.warnings.length > 0 ? (
              <div className="mt-3 max-h-36 overflow-auto rounded border bg-amber-50 p-2 text-xs text-amber-800">
                {validation.warnings.slice(0, 10).map((warning, index) => (
                  <p key={`${warning.check}-${index}`}>{warning.message}</p>
                ))}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => setExportDialogOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:bg-slate-400"
                onClick={() => void downloadExport()}
                disabled={validation.summary.error_count > 0 || exporting}
              >
                {exporting ? "Downloading..." : "Download .imdf"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
