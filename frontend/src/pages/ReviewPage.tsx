import { ChevronRight, Globe, Moon, PanelLeft, Sun, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  autofillWizardAddressFromGeometry,
  autofixSession,
  deleteSessionFeature,
  exportSessionArchive,
  exportSessionQgisProject,
  exportSessionShapefiles,
  fetchFeatureTypeCatalog,
  fetchSessionFiles,
  fetchSessionFeatures,
  generateSessionDraft,
  patchSessionFeature,
  patchSessionFeaturesBulk,
  resolveSessionUnitOverlap,
  resolveSessionUnitOverlapsSafe,
  snapOpening,
  type FeatureTypeOption,
  type ShapefileExportEncoding,
  type ShapefileExportRequest,
  type WizardState,
  validateSession,
  type ValidationIssue,
  type ValidationResponse} from "../api/client";
import { FeatureList } from "../components/review/FeatureList";
import { FilterBar, activeFilterCount } from "../components/review/FilterBar";
import { IssuesPanel } from "../components/review/IssuesPanel";
import {
  buildFloorGroups,
  buildLevelOptions,
  defaultFloorId,
  featureLevelId,
  levelIdsForFloor
} from "../components/review/floorGroups";
import { LayerTree } from "../components/review/LayerTree";
import { VenueDetailsPanel, type AddressParts } from "../components/review/VenueDetailsPanel";
import { MapPanel } from "../components/review/MapPanel";
import { compatibleFeatureTypes, geometryKindOf, typeIsCompatible } from "../components/review/featureTypeOptions";
import { PropertiesPanel } from "../components/review/PropertiesPanel";
import { TablePanel } from "../components/review/TablePanel";
import { ValidationBar } from "../components/review/ValidationBar";
import { ErrorBoundary } from "../components/shared/ErrorBoundary";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast } from "../components/shared/ToastProvider";
import { type ReviewFeature, featureLayerKey, featureName, layerKeyBaseType, orderedLayerKeys } from "../components/review/types";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Field,
  Input,
  Metric,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea
} from "../components/ui";
import { StepIndicator } from "../components/shell/StepIndicator";
import { cn } from "@/lib/utils";


/** Only these feature types are visible by default on the map. */
const DEFAULT_VISIBLE_TYPES = new Set(["unit", "detail", "opening"]);
type ExportFormat = "imdf" | "imdf_zip" | "shapefiles" | "odc2026_shapefiles" | "qgis_project";

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

function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function parseLegacyCodeMappings(raw: string): { mapping: Record<string, string>; invalidLines: string[] } {
  const mapping: Record<string, string> = {};
  const invalidLines: string[] = [];

  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const match = trimmed.match(/^([^=,:]+)\s*[=,:]\s*(.+)$/);
    if (!match) {
      invalidLines.push(`line ${index + 1}`);
      return;
    }
    const category = match[1].trim().toLowerCase();
    const code = match[2].trim();
    if (!category || !code) {
      invalidLines.push(`line ${index + 1}`);
      return;
    }
    mapping[category] = code;
  });

  return { mapping, invalidLines };
}

function buildShapefileDefaultsFromWizard(wizardState: WizardState | null): {
  sourceCategoryField: string;
  legacyMapText: string;
} {
  const codeByCategory: Record<string, string> = {};
  if (wizardState?.company_mappings) {
    Object.entries(wizardState.company_mappings)
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([rawCode, rawCategory]) => {
        const code = rawCode.trim();
        const category = rawCategory.trim().toLowerCase();
        if (!code || !category || codeByCategory[category]) {
          return;
        }
        codeByCategory[category] = code;
      });
  }

  const legacyMapText = Object.entries(codeByCategory)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, code]) => `${category}=${code}`)
    .join("\n");

  return {
    sourceCategoryField: wizardState?.mappings.unit.code_column?.trim() ?? "",
    legacyMapText
  };
}


/** Radix Select has no empty-string value, so "no level chosen" needs one. */
const BULK_NO_LEVEL = "__none__";


export function ReviewPage() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId);
  const importProfile = useAppStore((state) => state.importProfile);
  const setImportProfile = useAppStore((state) => state.setImportProfile);
  const files = useAppStore((state) => state.files);
  const setFiles = useAppStore((state) => state.setFiles);
  const wizardState = useAppStore((state) => state.wizardState);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
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

  const handleApiError = useApiErrorHandler();
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();
  const pushToast = useToast();

  const [features, setFeatures] = useState<ReviewFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapFloorFilter, setMapFloorFilter] = useState<string | null>(null);
  const [bulkLevel, setBulkLevel] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkFeatureType, setBulkFeatureType] = useState("");
  const [featureTypes, setFeatureTypes] = useState<FeatureTypeOption[]>([]);
  const [mergeName, setMergeName] = useState("");
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [overlayVisibility, setOverlayVisibility] = useState<Record<string, boolean>>({
    errors: true,
    warnings: true,
    overlaps: true
  });
  const [showBasemap, setShowBasemap] = useState(true);
  const [validating, setValidating] = useState(false);
  const [autofixing, setAutofixing] = useState(false);
  const [overlapResolving, setOverlapResolving] = useState(false);
  const [openingSnapping, setOpeningSnapping] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("imdf");
  const [shapefileEncoding, setShapefileEncoding] = useState<ShapefileExportEncoding>("preserve_source");
  const [shapefileSourceCategoryField, setShapefileSourceCategoryField] = useState("");
  const [shapefileWriteCategoryToNewField, setShapefileWriteCategoryToNewField] = useState(false);
  const [shapefileCategoryField, setShapefileCategoryField] = useState("IMDF_CAT");
  const [shapefileLegacyCodeField, setShapefileLegacyCodeField] = useState("");
  const [shapefileLegacyMapText, setShapefileLegacyMapText] = useState("");
  const [shapefileExportName, setShapefileExportName] = useState("");
  const [exportOptionsError, setExportOptionsError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarTab, setSidebarTab] = useState("features");
  const [mainView, setMainView] = useState<"map" | "table">("map");
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [activeIssueIndex, setActiveIssueIndex] = useState<number | null>(null);
  const [issuesPanelCollapsed, setIssuesPanelCollapsed] = useState(false);

  const captureError = (caught: unknown, fallbackMessage: string, title: string) => {
    const message = handleApiError(caught, fallbackMessage, { title });
    setError(message);
    return message;
  };

  useEffect(() => {
    if (!sessionId) {
      navigate("/");
      return;
    }
  }, [navigate, sessionId]);

  const loadFeatures = async (): Promise<ReviewFeature[]> => {
    if (!sessionId) {
      return [];
    }
    setLoading(true);
    setError(null);
    try {
      const [fileResponse, initialFeatureResponse] = await Promise.all([
        fetchSessionFiles(sessionId),
        fetchSessionFeatures(sessionId)
      ]);
      setFiles(fileResponse.files);
      setImportProfile(fileResponse.import_profile ?? "standard");

      let response = initialFeatureResponse;
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
      return rows;
    } catch (caught) {
      captureError(caught, t("Failed to load review data", "レビュー データの読み込みに失敗しました"), t("Review load failed", "レビュー読み込み失敗"));
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFeatures();
  }, [sessionId]);

  useEffect(() => {
    void fetchFeatureTypeCatalog()
      .then((types) => {
        setFeatureTypes(types);
      })
      .catch(() => {
        setFeatureTypes([]);
      });
  }, []);

  // The viewer filters by floor so a floor split across several Level features
  // (新宿 1F is eight platforms plus 1F and 1F屋外) is shown in one piece.
  const floorOptions = useMemo(() => buildFloorGroups(features), [features]);
  const levelOptions = useMemo(() => buildLevelOptions(features), [features]);
  const visibleLevelIds = useMemo(
    () => levelIdsForFloor(floorOptions, mapFloorFilter ?? ""),
    [floorOptions, mapFloorFilter]
  );

  // Open on the lowest floor, and recover when the chosen floor disappears
  // (features reload after an edit). "All floors" is a deliberate choice and has
  // to survive both, hence null for "nothing chosen yet".
  useEffect(() => {
    if (floorOptions.length === 0) {
      return;
    }
    const stale =
      mapFloorFilter !== null &&
      mapFloorFilter !== "" &&
      !floorOptions.some((floor) => floor.id === mapFloorFilter);
    if (mapFloorFilter === null || stale) {
      setMapFloorFilter(defaultFloorId(floorOptions, features) ?? floorOptions[0].id);
    }
  }, [features, floorOptions, mapFloorFilter]);

  const venueFeature = useMemo(
    () => features.find((item) => item.feature_type === "venue") ?? null,
    [features]
  );
  const buildingFeature = useMemo(
    () => features.find((item) => item.feature_type === "building") ?? null,
    [features]
  );
  const addressFeature = useMemo(
    () => features.find((item) => item.feature_type === "address") ?? null,
    [features]
  );

  const addressOptions = useMemo(() => {
    return features
      .filter((item) => item.feature_type === "address")
      .map((item) => ({
        id: item.id,
        label: typeof item.properties.address === "string" ? item.properties.address : item.id.slice(0, 8)
      }));
  }, [features]);

  const layerKeys = useMemo(() => orderedLayerKeys(features), [features]);

  // Filter options come from the data rather than a fixed list: a session only
  // ever holds the feature types and categories its own shapefiles produced.
  const filterFeatureTypes = useMemo(
    () => [...new Set(features.map((item) => item.feature_type))].sort(),
    [features]
  );
  const filterCategories = useMemo(() => {
    const found = new Set<string>();
    features.forEach((item) => {
      const category = item.properties.category;
      if (typeof category === "string" && category.trim()) {
        found.add(category);
      }
    });
    return [...found].sort();
  }, [features]);

  // Initialize layer visibility: only unit/detail/opening ON by default
  useEffect(() => {
    if (layerKeys.length === 0) {
      return;
    }
    const missingKeys = layerKeys.filter((key) => !(key in layerVisibility));
    if (missingKeys.length === 0) {
      return;
    }

    const nextVisibility: Record<string, boolean> = {};
    missingKeys.forEach((key) => {
      nextVisibility[key] = DEFAULT_VISIBLE_TYPES.has(layerKeyBaseType(key));
    });
    setLayerVisibility({ ...layerVisibility, ...nextVisibility });
  }, [layerVisibility, layerKeys, setLayerVisibility]);

  const filteredFeatures = useMemo(() => applyFilters(features, filters), [features, filters]);
  const filterCount = activeFilterCount(filters);

  const selectedFeature = useMemo(() => {
    if (selectedFeatureIds.length === 0) {
      return null;
    }
    return features.find((item) => item.id === selectedFeatureIds[0]) ?? null;
  }, [features, selectedFeatureIds]);

  const bulkTypeOptions = useMemo(() => {
    const selected = features.filter((item) => selectedFeatureIds.includes(item.id));
    if (selected.length === 0) {
      return [] as FeatureTypeOption[];
    }
    return compatibleFeatureTypes(featureTypes, selected[0].geometry).filter((option) =>
      selected.every((item) => typeIsCompatible(option, geometryKindOf(item.geometry)))
    );
  }, [features, featureTypes, selectedFeatureIds]);

  // Auto-show right sidebar when a feature is selected
  useEffect(() => {
    setRightSidebarOpen(Boolean(selectedFeature));
    setActiveIssueIndex(null);
  }, [selectedFeature]);

  const saveFeatureProperties = async (
    featureId: string,
    properties: Record<string, unknown>,
    featureType?: string
  ) => {
    if (!sessionId) {
      return;
    }
    const previous = features.find((item) => item.id === featureId);
    if (!previous) {
      return;
    }
    pushEditHistory({
      featureId,
      previousProperties: previous.properties,
      previousFeatureType: previous.feature_type
    });

    try {
      const updated = await patchSessionFeature(
        sessionId,
        featureId,
        featureType ? { properties, feature_type: featureType } : { properties }
      );
      const nextFeature: ReviewFeature = {
        type: updated.type,
        id: updated.id,
        feature_type: updated.feature_type,
        geometry: updated.geometry as { type: string; coordinates: unknown } | null,
        properties: updated.properties as Record<string, unknown>
      };
      setFeatures((prev) =>
        prev.map((item) => (item.id === updated.id ? nextFeature : item))
      );
      if (updated.feature_type !== previous.feature_type) {
        const key = featureLayerKey(nextFeature);
        if (layerVisibility[key] !== true) {
          setLayerVisibility({ ...layerVisibility, [key]: true });
        }
      }
    } catch (caught) {
      captureError(caught, "Failed to save feature", "Save failed");
    }
  };

  const requestAddressAutofill = async (): Promise<AddressParts | null> => {
    if (!sessionId) {
      return null;
    }
    try {
      const response = await autofillWizardAddressFromGeometry(sessionId, wizardState?.project?.language ?? "en");
      if (!response.result) {
        pushToast({
          title: t("No address found", "住所が見つかりません"),
          description: response.warnings[0] ?? t("Geocoding returned no match.", "ジオコーディングの結果がありません。")
        });
        return null;
      }
      return response.result.address;
    } catch (caught) {
      captureError(caught, t("Address lookup failed", "住所の取得に失敗しました"), t("Lookup failed", "取得失敗"));
      return null;
    }
  };

  const deleteFeature = async (featureId: string) => {
    if (!sessionId) {
      return;
    }
    if (!window.confirm(t("Delete this feature?", "このフィーチャーを削除しますか？"))) {
      return;
    }
    try {
      await deleteSessionFeature(sessionId, featureId);
      setFeatures((prev) => prev.filter((item) => item.id !== featureId));
      setSelectedFeatureIds(selectedFeatureIds.filter((id) => id !== featureId));
      pushToast({ title: t("Feature deleted", "フィーチャーを削除しました"), variant: "success" });
    } catch (caught) {
      captureError(caught, t("Failed to delete feature", "フィーチャーの削除に失敗しました"), t("Delete failed", "削除失敗"));
    }
  };

  const applyBulkLevel = async () => {
    if (!sessionId || !bulkLevel || selectedFeatureIds.length === 0) {
      return;
    }
    try {
      await patchSessionFeaturesBulk(sessionId, {
        feature_ids: selectedFeatureIds,
        action: "patch",
        properties: {
          level_id: bulkLevel
        }
      });
      await loadFeatures();
      pushToast({
        title: t("Bulk update applied", "一括更新を適用しました"),
        description: t("Level reassignment completed.", "レベル再割り当てが完了しました。"),
        variant: "success"
      });
    } catch (caught) {
      captureError(caught, t("Bulk level update failed", "レベルの一括更新に失敗しました"), t("Bulk edit failed", "一括編集失敗"));
    }
  };

  const applyBulkCategory = async () => {
    if (!sessionId || !bulkCategory || selectedFeatureIds.length === 0) {
      return;
    }
    try {
      await patchSessionFeaturesBulk(sessionId, {
        feature_ids: selectedFeatureIds,
        action: "patch",
        properties: {
          category: bulkCategory
        }
      });
      await loadFeatures();
      pushToast({
        title: t("Bulk update applied", "一括更新を適用しました"),
        description: t("Category reassignment completed.", "カテゴリ再割り当てが完了しました。"),
        variant: "success"
      });
    } catch (caught) {
      captureError(caught, t("Bulk category update failed", "カテゴリの一括更新に失敗しました"), t("Bulk edit failed", "一括編集失敗"));
    }
  };

  const applyBulkFeatureType = async () => {
    if (!sessionId || !bulkFeatureType || selectedFeatureIds.length === 0) {
      return;
    }
    const targetType = bulkFeatureType;
    const sampleId = features.find((item) => selectedFeatureIds.includes(item.id))?.id;
    try {
      await patchSessionFeaturesBulk(sessionId, {
        feature_ids: selectedFeatureIds,
        action: "patch",
        feature_type: targetType
      });
      const rows = await loadFeatures();
      const reloaded =
        (sampleId ? rows.find((item) => item.id === sampleId) : undefined) ??
        rows.find((item) => selectedFeatureIds.includes(item.id) && item.feature_type === targetType);
      const key = reloaded ? featureLayerKey(reloaded) : targetType;
      if (layerVisibility[key] !== true) {
        setLayerVisibility({ ...layerVisibility, [key]: true });
      }
      setBulkFeatureType("");
      pushToast({
        title: t("Feature type changed", "フィーチャー種別を変更しました"),
        variant: "success"
      });
    } catch (caught) {
      captureError(
        caught,
        t("Bulk feature type change failed", "フィーチャー種別の一括変更に失敗しました"),
        t("Bulk edit failed", "一括編集失敗")
      );
    }
  };

  const mergeSelectedUnits = async () => {
    if (!sessionId || selectedFeatureIds.length < 2) {
      return;
    }
    try {
      await patchSessionFeaturesBulk(sessionId, {
        feature_ids: selectedFeatureIds,
        action: "merge_units",
        merge_name: mergeName || null
      });
      clearSelectedFeatureIds();
      await loadFeatures();
      pushToast({ title: t("Units merged", "ユニットを結合しました"), variant: "success" });
    } catch (caught) {
      captureError(caught, t("Failed to merge selected units", "選択したユニットの結合に失敗しました"), t("Merge failed", "結合失敗"));
    }
  };

  const deleteSelected = async () => {
    if (!sessionId || selectedFeatureIds.length === 0) {
      return;
    }
    if (!window.confirm(t(`Delete ${selectedFeatureIds.length} selected features?`, `選択中の ${selectedFeatureIds.length} 件を削除しますか？`))) {
      return;
    }
    try {
      await patchSessionFeaturesBulk(sessionId, {
        feature_ids: selectedFeatureIds,
        action: "delete"
      });
      clearSelectedFeatureIds();
      await loadFeatures();
      pushToast({ title: t("Selection deleted", "選択項目を削除しました"), variant: "success" });
    } catch (caught) {
      captureError(caught, t("Failed to delete selected features", "選択したフィーチャーの削除に失敗しました"), t("Delete failed", "削除失敗"));
    }
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

  const activeIssue = useMemo(() => {
    if (activeIssueIndex === null) return null;
    return selectedFeatureIssues[activeIssueIndex] ?? null;
  }, [activeIssueIndex, selectedFeatureIssues]);

  // When an issue is activated, switch the map to that feature's level so the
  // zoomed-to geometry is actually visible — otherwise the map fits to a feature
  // that the current level filter is hiding.
  useEffect(() => {
    if (!activeIssue) {
      return;
    }
    const targetId = activeIssue.feature_id ?? activeIssue.related_feature_id;
    if (!targetId) {
      return;
    }
    const target = features.find((item) => item.id === targetId);
    if (!target) {
      return;
    }
    const levelId = featureLevelId(target);
    if (!levelId) {
      return;
    }
    if (mapFloorFilter === "") {
      return;
    }
    const floorId = floorOptions.find((floor) => floor.levelIds.includes(levelId))?.id;
    if (floorId && floorId !== mapFloorFilter) {
      setMapFloorFilter(floorId);
    }
  }, [activeIssue, features, floorOptions, mapFloorFilter]);

  const applyPostValidationState = (next: ValidationResponse) => {
    setActiveIssueIndex(null);
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
      pushToast({
        title: t("Validation complete", "検証が完了しました"),
        description: t(
          `${response.summary.error_count} errors, ${response.summary.warning_count} warnings.`,
          `エラー ${response.summary.error_count} 件、警告 ${response.summary.warning_count} 件。`
        ),
        variant: response.summary.error_count > 0 ? "info" : "success"
      });
      return response;
    } catch (caught) {
      captureError(caught, t("Validation failed", "検証に失敗しました"), t("Validation failed", "検証失敗"));
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
          t(
            `${response.total_requiring_confirmation} destructive fixes require confirmation. Apply them now?`,
            `${response.total_requiring_confirmation} 件の破壊的修正には確認が必要です。今すぐ適用しますか？`
          )
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
      pushToast({
        title: t("Auto-fix completed", "自動修正が完了しました"),
        description: t(`${response.total_fixed} issue(s) fixed automatically.`, `${response.total_fixed} 件を自動修正しました。`),
        variant: "success"
      });
    } catch (caught) {
      captureError(caught, t("Auto-fix failed", "自動修正に失敗しました"), t("Auto-fix failed", "自動修正失敗"));
    } finally {
      setAutofixing(false);
    }
  };

  const resolveOverlapPair = async (keepFeatureId: string, clipFeatureId: string) => {
    if (!sessionId) {
      return;
    }
    setOverlapResolving(true);
    setError(null);
    try {
      const response = await resolveSessionUnitOverlap(sessionId, keepFeatureId, clipFeatureId);
      applyPostValidationState(response.validation);
      await loadFeatures();
      if (response.deleted_count > 0) {
        setSelectedFeatureIds(selectedFeatureIds.filter((item) => item !== clipFeatureId));
      }
      pushToast({
        title: t("Overlap resolved", "重なりを解消しました"),
        description: t(
          `${response.resolved_pairs} overlap pair resolved.`,
          `${response.resolved_pairs} 件の重なりを解消しました。`
        ),
        variant: "success"
      });
    } catch (caught) {
      captureError(caught, t("Failed to resolve overlap", "重なりの解消に失敗しました"), t("Overlap fix failed", "重なり修正失敗"));
    } finally {
      setOverlapResolving(false);
    }
  };

  const handleSnapOpening = async (openingId: string, unitId: string) => {
    if (!sessionId) {
      return;
    }
    setOpeningSnapping(true);
    setError(null);
    try {
      const response = await snapOpening(sessionId, openingId, unitId);
      applyPostValidationState(response.validation);
      await loadFeatures();
      pushToast({
        title: t("Opening snapped", "開口部をスナップしました"),
        description: t("Opening moved to unit boundary.", "開口部をユニット境界に移動しました。"),
        variant: "success"
      });
    } catch (caught) {
      captureError(caught, t("Failed to snap opening", "開口部のスナップに失敗しました"), t("Snap failed", "スナップ失敗"));
    } finally {
      setOpeningSnapping(false);
    }
  };

  const resolveSafeOverlaps = async () => {
    if (!sessionId) {
      return;
    }
    setOverlapResolving(true);
    setError(null);
    try {
      const response = await resolveSessionUnitOverlapsSafe(sessionId);
      applyPostValidationState(response.validation);
      await loadFeatures();
      pushToast({
        title: t("Safe overlap fix complete", "安全な重なり修正が完了しました"),
        description: t(
          `${response.resolved_pairs} resolved, ${response.skipped_count} need review.`,
          `${response.resolved_pairs} 件解消、${response.skipped_count} 件は確認が必要です。`
        ),
        variant: response.skipped_count > 0 ? "info" : "success"
      });
    } catch (caught) {
      captureError(
        caught,
        t("Failed to apply safe overlap fix", "安全な重なり修正の適用に失敗しました"),
        t("Overlap fix failed", "重なり修正失敗")
      );
    } finally {
      setOverlapResolving(false);
    }
  };

  const hasGeoPackageSources = useMemo(
    () => files.some((item) => item.source_format === "gpkg"),
    [files]
  );
  const exportBlocked = (exportFormat === "shapefiles" || exportFormat === "odc2026_shapefiles" || exportFormat === "qgis_project") && hasGeoPackageSources;

  useEffect(() => {
    if (hasGeoPackageSources && (exportFormat === "shapefiles" || exportFormat === "odc2026_shapefiles" || exportFormat === "qgis_project")) {
      setExportFormat("imdf");
    }
  }, [exportFormat, hasGeoPackageSources]);
  const openExportDialog = async () => {
    const validationResult = await runValidation();
    if (!validationResult) {
      return;
    }
    const defaults = buildShapefileDefaultsFromWizard(wizardState);
    const sourceCategoryField = defaults.sourceCategoryField.trim();
    setExportFormat(importProfile === "imdf_shapefile" && !hasGeoPackageSources ? "odc2026_shapefiles" : "imdf");
    setShapefileEncoding("preserve_source");
    setShapefileSourceCategoryField(sourceCategoryField);
    setShapefileWriteCategoryToNewField(false);
    setShapefileCategoryField(sourceCategoryField || "IMDF_CAT");
    setShapefileLegacyCodeField("");
    setShapefileLegacyMapText(defaults.legacyMapText);
    setShapefileExportName("");
    setExportOptionsError(null);
    setExportDialogOpen(true);
  };

  const downloadExport = async () => {
    if (!sessionId) {
      return;
    }
    if ((exportFormat === "shapefiles" || exportFormat === "odc2026_shapefiles" || exportFormat === "qgis_project") && hasGeoPackageSources) {
      const message = t(
        "Shapefile/QGIS export is unavailable for sessions imported from GeoPackages. Use IMDF export instead.",
        "シェープファイル・QGIS エクスポートは GeoPackage から読み込んだセッションでは利用できません。IMDF エクスポートを使用してください。"
      );
      setExportOptionsError(message);
      setError(message);
      pushToast({ title: t("Export unavailable", "Export unavailable"), description: message, variant: "error" });
      return;
    }

    let shapefilePayload: ShapefileExportRequest | null = null;
    if (exportFormat === "shapefiles") {
      const sourceField = shapefileSourceCategoryField.trim();
      const fallbackCategoryField =
        shapefileWriteCategoryToNewField || !sourceField
          ? "IMDF_CAT"
          : sourceField;
      const imdfCategoryField = shapefileCategoryField.trim() || fallbackCategoryField;
      const legacyCodeField = shapefileLegacyCodeField.trim();
      let legacyCodeMap: Record<string, string> = {};

      if (legacyCodeField) {
        const parsed = parseLegacyCodeMappings(shapefileLegacyMapText);
        if (parsed.invalidLines.length > 0) {
          const message = t(
            `Legacy mapping format is invalid (${parsed.invalidLines.join(", ")}). Use category=CODE.`,
            `Legacy mapping format is invalid (${parsed.invalidLines.join(", ")}). Use category=CODE.`
          );
          setExportOptionsError(message);
          setError(message);
          return;
        }
        legacyCodeMap = parsed.mapping;
      }

      if (legacyCodeField && legacyCodeField.toLowerCase() === imdfCategoryField.toLowerCase()) {
        const message = t(
          "Legacy code field must differ from the IMDF category field.",
          "Legacy code field must differ from the IMDF category field."
        );
        setExportOptionsError(message);
        setError(message);
        return;
      }

      setExportOptionsError(null);
      shapefilePayload = {
        profile: "imdf_roundtrip",
        mode: "source_update",
        encoding: shapefileEncoding,
        include_report: true,
        unit: {
          write_imdf_category: true,
          imdf_category_field: imdfCategoryField,
          overwrite_legacy_code_field: legacyCodeField || null,
          legacy_code_map: legacyCodeMap
        }
      };
    } else if (exportFormat === "odc2026_shapefiles" || exportFormat === "qgis_project") {
      const exportName = shapefileExportName.trim();
      if (!exportName) {
        const message = t(
          "Enter an export file prefix.",
          "エクスポートファイルの接頭辞を入力してください。"
        );
        setExportOptionsError(message);
        setError(message);
        return;
      }
      setExportOptionsError(null);
      shapefilePayload = {
        profile: "odc2026",
        mode: "source_update",
        encoding: shapefileEncoding,
        include_report: true,
        export_name: exportName,
        unit: {
          write_imdf_category: true,
          imdf_category_field: "IMDF_CAT",
          overwrite_legacy_code_field: null,
          legacy_code_map: {}
        }
      };
    }

    setExporting(true);
    setError(null);
    try {
      const isQgis = exportFormat === "qgis_project";
      const response = isQgis
        ? await exportSessionQgisProject(sessionId, shapefilePayload as ShapefileExportRequest)
        : exportFormat === "shapefiles" || exportFormat === "odc2026_shapefiles"
          ? await exportSessionShapefiles(sessionId, shapefilePayload as ShapefileExportRequest)
          : await exportSessionArchive(sessionId, exportFormat === "imdf_zip");
      const url = window.URL.createObjectURL(response.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setExportDialogOpen(false);
      pushToast({
        title: t("Export ready", "Export ready"),
        description: t(`${response.filename} downloaded.`, `${response.filename} downloaded.`),
        variant: "success"
      });
    } catch (caught) {
      captureError(
        caught,
        t("Export failed", "Export failed"),
        exportFormat === "qgis_project"
          ? t("QGIS project export failed", "QGIS プロジェクトのエクスポートに失敗しました")
          : exportFormat === "shapefiles" || exportFormat === "odc2026_shapefiles"
            ? t("Shapefile export failed", "Shapefile export failed")
            : t("Export failed", "Export failed")
      );
    } finally {
      setExporting(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";
      if (isUndo) {
        if (isFormTarget(event.target)) {
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
        const previousFeatureType = popped.previousFeatureType;
        if (typeof featureId !== "string" || !previousProperties || typeof previousProperties !== "object") {
          return;
        }
        void patchSessionFeature(sessionId, featureId, {
          properties: previousProperties as Record<string, unknown>,
          ...(typeof previousFeatureType === "string" && previousFeatureType
            ? { feature_type: previousFeatureType }
            : {})
        })
          .then((updated) => {
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
          })
          .catch((caught) => {
            captureError(caught, "Undo failed", "Undo failed");
          });
        return;
      }

      if (event.key === "Escape" && !isFormTarget(event.target)) {
        event.preventDefault();
        clearSelectedFeatureIds();
        if (exportDialogOpen) {
          setExportDialogOpen(false);
        }
        return;
      }

      if (
        event.key === "Enter" &&
        exportDialogOpen &&
        !isFormTarget(event.target) &&
        !exporting &&
        !validating &&
        !exportBlocked
      ) {
        event.preventDefault();
        void downloadExport();
        return;
      }

      // Ctrl+E → export
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e" && !isFormTarget(event.target)) {
        event.preventDefault();
        if (!exporting && !validating && !loading) {
          void openExportDialog();
        }
        return;
      }

      // Ctrl+Shift+V → validate
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v" && !isFormTarget(event.target)) {
        event.preventDefault();
        if (!validating && !loading) {
          void runValidation();
        }
        return;
      }

      // Delete → delete selected features
      if (event.key === "Delete" && !isFormTarget(event.target) && selectedFeatureIds.length > 0) {
        event.preventDefault();
        void deleteSelected();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelectedFeatureIds,
    downloadExport,
    exportDialogOpen,
    exporting,
    popEditHistory,
    sessionId,
    exportBlocked,
    validating,
    validation
  ]);

  // ─── Layout ───────────────────────────────────────────────────────────

  const sidebarWidth = sidebarCollapsed ? 0 : 340;

  return (
    <div className="flex h-screen flex-col bg-muted">
      {/* Top bar — mirrors AppShell but inline since review opts out of shell */}
      {/* Review opts out of AppShell for its full-bleed layout, so it has to
          carry the shell's own controls — the theme toggle was simply missing
          here, which left dark mode unreachable once you reached Review. */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            aria-label={sidebarCollapsed ? t("Show sidebar", "サイドバーを表示") : t("Hide sidebar", "サイドバーを非表示")}
            title={sidebarCollapsed ? t("Show sidebar", "サイドバーを表示") : t("Hide sidebar", "サイドバーを非表示")}
          >
            <PanelLeft />
          </Button>
          <span className="text-[13px] font-semibold leading-[18px] tracking-tight text-foreground">
            IMDF Converter
          </span>
        </div>

        <StepIndicator />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={t("Switch theme", "テーマを切り替え")}
            title={
              theme === "dark"
                ? t("Switch to light", "ライトに切り替え")
                : t("Switch to dark", "ダークに切り替え")
            }
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUiLanguage(uiLanguage === "en" ? "ja" : "en")}
            title={t("Switch UI language", "表示言語を切り替え")}
          >
            <Globe className="h-3.5 w-3.5" />
            {uiLanguage === "en" ? "日本語" : "EN"}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {/* Main area: left sidebar + map + right sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left sidebar: Features / Layers ── */}
        {/* Both used to be stacked in one scroller, so the layer panel ate the
            top 300px and the feature list — the thing you came here to work
            through — started below the fold. */}
        {!sidebarCollapsed ? (
          <aside
            className="flex flex-col border-r border-border bg-card"
            style={{ width: sidebarWidth, minWidth: sidebarWidth }}
          >
            <Tabs
              value={sidebarTab}
              onValueChange={setSidebarTab}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-3 mt-3 grid grid-cols-2">
                <TabsTrigger value="features">
                  {t("Features", "フィーチャー")}
                </TabsTrigger>
                <TabsTrigger value="layers">{t("Layers", "レイヤー")}</TabsTrigger>
              </TabsList>

              <TabsContent
                value="features"
                className="flex min-h-0 flex-1 flex-col data-[state=active]:mt-3"
              >
                {importProfile === "imdf_shapefile" ? (
                  <VenueDetailsPanel
                    venue={venueFeature}
                    building={buildingFeature}
                    address={addressFeature}
                    language={wizardState?.project?.language ?? "en"}
                    onSave={(featureId, properties) => void saveFeatureProperties(featureId, properties)}
                    onRequestAutofill={requestAddressAutofill}
                  />
                ) : null}

                {loading ? (
                  <div className="flex flex-col gap-2 p-3">
                    <SkeletonBlock className="h-6 w-full" />
                    <SkeletonBlock className="h-6 w-full" />
                    <SkeletonBlock className="h-6 w-full" />
                    <SkeletonBlock className="h-6 w-full" />
                    <SkeletonBlock className="h-6 w-full" />
                  </div>
                ) : (
                  <>
                    {filters.status ? (
                      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs leading-4 text-muted-foreground">
                        <span>
                          {t("Showing", "表示中")}:{" "}
                          <span className="font-medium capitalize text-foreground">{filters.status}</span>
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto h-auto px-1.5 py-0.5 text-xs font-normal"
                          onClick={() => setFilters({ ...filters, status: undefined })}
                        >
                          {t("Clear", "解除")}
                        </Button>
                      </div>
                    ) : null}
                    <FeatureList
                      features={filteredFeatures}
                      selectedFeatureIds={selectedFeatureIds}
                      validationIssues={allValidationIssues}
                      onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
                      onSelectionChange={(ids) => setSelectedFeatureIds(ids)}
                    />
                  </>
                )}
              </TabsContent>

              <TabsContent
                value="layers"
                className="min-h-0 flex-1 overflow-y-auto p-3 data-[state=active]:mt-1"
              >
                <LayerTree
                  featureTypes={layerKeys}
                  layerVisibility={layerVisibility}
                  floorFilter={mapFloorFilter ?? ""}
                  floorOptions={floorOptions}
                  validationLoaded={validation !== null}
                  overlayVisibility={overlayVisibility}
                  showBasemap={showBasemap}
                  onLayerVisibilityChange={setLayerVisibility}
                  onFloorFilterChange={setMapFloorFilter}
                  onOverlayVisibilityChange={setOverlayVisibility}
                  onShowBasemapChange={setShowBasemap}
                />
              </TabsContent>
            </Tabs>

            {/* Bulk actions bar (when multiple selected) */}
            {selectedFeatureIds.length > 1 ? (
              <div className="shrink-0 border-t border-border bg-muted p-2.5">
                <div className="mb-2 font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                  {selectedFeatureIds.length} {t("selected", "選択中")}
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-1.5">
                    <Select value={bulkLevel || BULK_NO_LEVEL} onValueChange={(value) => setBulkLevel(value === BULK_NO_LEVEL ? "" : value)}>
                      <SelectTrigger className="h-8 flex-1" aria-label={t("Level", "レベル")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={BULK_NO_LEVEL}>{t("Level…", "レベル…")}</SelectItem>
                        {levelOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={() => void applyBulkLevel()} disabled={!bulkLevel}>
                      {t("Apply", "適用")}
                    </Button>
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      className="h-8 flex-1"
                      placeholder={t("Category", "カテゴリ")}
                      value={bulkCategory}
                      onChange={(e) => setBulkCategory(e.target.value)}
                    />
                    <Button variant="outline" size="sm" onClick={() => void applyBulkCategory()} disabled={!bulkCategory}>
                      {t("Apply", "適用")}
                    </Button>
                  </div>
                  <div className="flex gap-1.5">
                    <select
                      className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                      aria-label={t("Type", "種別")}
                      value={bulkFeatureType}
                      onChange={(e) => setBulkFeatureType(e.target.value)}
                    >
                      <option value="">{t("Type...", "種別...")}</option>
                      {bulkTypeOptions.map((option) => (
                        <option key={option.feature_type} value={option.feature_type}>
                          {option.feature_type}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void applyBulkFeatureType()}
                      disabled={!bulkFeatureType}
                    >
                      {t("Apply", "適用")}
                    </Button>
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      className="h-8 flex-1"
                      placeholder={t("Merge name", "結合名")}
                      value={mergeName}
                      onChange={(e) => setMergeName(e.target.value)}
                    />
                    <Button variant="outline" size="sm" onClick={() => void mergeSelectedUnits()}>
                      {t("Merge", "結合")}
                    </Button>
                  </div>
                  <Button variant="destructive" size="sm" onClick={() => void deleteSelected()}>
                    {t("Delete selected", "選択を削除")}
                  </Button>
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}

        {/* ── Main area: map or table ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 py-1.5">
            <div
              role="group"
              aria-label={t("View", "表示")}
              className="inline-flex gap-0.5 rounded-md bg-muted p-1"
            >
              {([
                ["map", t("Map", "地図")],
                ["table", t("Table", "表")]
              ] as const).map(([view, label]) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={mainView === view}
                  onClick={() => setMainView(view)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-[13px] font-medium leading-[18px] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    mainView === view
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
              {filterCount > 0
                ? t(
                    `${filteredFeatures.length} of ${features.length} features`,
                    `${features.length} 件中 ${filteredFeatures.length} 件`
                  )
                : t(`${features.length} features`, `${features.length} 件`)}
            </span>
          </div>

          {/* The map stays mounted behind the table rather than unmounting on
              every view switch: rebuilding a MapLibre instance throws away the
              tiles, the camera and the fitted bounds. */}
          <div className="relative min-h-0 flex-1">
            {/* Hidden with opacity rather than `visibility` or `display`: a
                descendant can override `visibility` — MapLibre's attribution
                control does, and the © OpenStreetMap pill floated over the
                table — and `display: none` makes the map lose its size, which
                means a resize on every switch back. Opacity does neither. */}
            <div
              className={cn(
                "absolute inset-0 transition-opacity",
                mainView === "table" && "pointer-events-none opacity-0"
              )}
              aria-hidden={mainView === "table"}
            >
              {loading ? (
                <div className="flex h-full items-center justify-center bg-muted">
                  <SkeletonBlock className="h-full w-full" />
                </div>
              ) : (
                <ErrorBoundary>
                  <MapPanel
                    features={features}
                    selectedFeatureIds={selectedFeatureIds}
                    layerVisibility={layerVisibility}
                    validationIssues={allValidationIssues}
                    overlayVisibility={overlayVisibility}
                    visibleLevelIds={visibleLevelIds}
                    showBasemap={showBasemap}
                    activeIssue={activeIssue}
                    onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
                  />
                </ErrorBoundary>
              )}
            </div>

            {mainView === "table" ? (
              <div className="absolute inset-0 flex flex-col gap-3 overflow-auto bg-muted p-3">
                <FilterBar
                  filters={filters}
                  featureTypes={filterFeatureTypes}
                  levels={levelOptions}
                  categories={filterCategories}
                  onChange={(next) => setFilters(next)}
                />
                <TablePanel
                  features={filteredFeatures}
                  levelOptions={levelOptions}
                  selectedFeatureIds={selectedFeatureIds}
                  onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
                  onSelectionChange={(ids) => setSelectedFeatureIds(ids)}
                />
              </div>
            ) : null}
          </div>
        </div>

        {/* ── Right sidebar: Properties ── */}
        {rightSidebarOpen && selectedFeature ? (
          <aside
            className="flex flex-col border-l border-border bg-card overflow-y-auto"
            style={{ width: 340, minWidth: 340 }}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
              <span className="text-[13px] font-semibold leading-[18px] text-foreground">
                {t("Properties", "プロパティ")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("Close properties", "プロパティを閉じる")}
                onClick={() => setRightSidebarOpen(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
              {selectedFeatureIssues.length > 0 ? (
                <IssuesPanel
                  issues={selectedFeatureIssues}
                  activeIndex={activeIssueIndex}
                  collapsed={issuesPanelCollapsed}
                  feature={selectedFeature}
                  allFeatures={features}
                  autoFixing={autofixing}
                  overlapResolving={overlapResolving}
                  openingSnapping={openingSnapping}
                  onSelectIssue={setActiveIssueIndex}
                  onToggleCollapsed={() => setIssuesPanelCollapsed((prev) => !prev)}
                  onAutoFixSafe={() => void runAutofix(false)}
                  onResolveUnitOverlap={(keepFeatureId, clipFeatureId) => void resolveOverlapPair(keepFeatureId, clipFeatureId)}
                  onSnapOpening={(openingId, unitId) => void handleSnapOpening(openingId, unitId)}
                />
              ) : null}
              <PropertiesPanel
                feature={selectedFeature}
                language={wizardState?.project?.language ?? "en"}
                levelOptions={levelOptions}
                addressOptions={addressOptions}
                featureTypes={featureTypes}
                onSave={(featureId, properties, featureType) => void saveFeatureProperties(featureId, properties, featureType)}
                onDelete={(featureId) => void deleteFeature(featureId)}
              />
            </div>
          </aside>
        ) : null}
      </div>

      {/* Validation bar */}
      <ValidationBar
        validation={validation}
        validating={validating}
        autofixing={autofixing}
        overlapResolving={overlapResolving}
        exporting={exporting}
        loading={loading}
        onValidate={() => void runValidation()}
        onAutoFix={() => void runAutofix(false)}
        onFixOverlaps={() => void resolveSafeOverlaps()}
        onExport={() => void openExportDialog()}
      />

      {/* Export dialog */}
      {/* Was a hand-rolled fixed overlay: no focus trap, no escape-to-close and
          no labelled dialog role. The advanced shapefile field options move
          behind a disclosure — three text inputs and a mapping textarea that
          only matter if you are replacing codes in an existing schema. */}
      <Dialog open={exportDialogOpen && validation !== null} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogTitle>{t("Export", "エクスポート")}</DialogTitle>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <Field label={t("Format", "形式")}>
              {(id) => (
                <Select
                  value={exportFormat}
                  onValueChange={(value) => setExportFormat(value as ExportFormat)}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="imdf">{t("IMDF (.imdf)", "IMDF (.imdf)")}</SelectItem>
                    <SelectItem value="imdf_zip">{t("IMDF (.zip)", "IMDF (.zip)")}</SelectItem>
                    {!hasGeoPackageSources ? (
                      <>
                        <SelectItem value="shapefiles">{t("Shapefiles (.zip)", "Shapefiles (.zip)")}</SelectItem>
                        <SelectItem value="odc2026_shapefiles">
                          {t("Open Data Contest 2026 shapefiles (.zip)", "オープンデータコンテスト2026 シェープファイル (.zip)")}
                        </SelectItem>
                        <SelectItem value="qgis_project">
                          {t("QGIS project (.qgz + shapefiles .zip)", "QGIS プロジェクト (.qgz + シェープファイル .zip)")}
                        </SelectItem>
                      </>
                    ) : null}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {exportFormat === "imdf_zip" ? (
              <p className="-mt-2 text-xs leading-4 text-muted-foreground">
                {t(
                  "Same contents as the .imdf archive, packaged as .zip for the IMDF Sandbox validator.",
                  "内容は .imdf アーカイブと同じで、IMDF Sandbox 検証用に .zip 形式でパッケージ化しています。"
                )}
              </p>
            ) : null}

            {hasGeoPackageSources ? (
              <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs leading-4 text-warning">
                {t(
                  "This session includes GeoPackage sources, so only IMDF export is available.",
                  "このセッションには GeoPackage ソースが含まれるため、IMDF 書き出しのみ利用できます。"
                )}
              </p>
            ) : null}

            {validation ? (
              <div className="flex gap-2">
                <Metric
                  label={t("FEATURES", "フィーチャー")}
                  value={validation.summary.total_features}
                  className="flex-1"
                />
                <Metric
                  label={t("ERRORS", "エラー")}
                  value={validation.summary.error_count}
                  className="flex-1"
                />
                <Metric
                  label={t("WARNINGS", "警告")}
                  value={validation.summary.warning_count}
                  className="flex-1"
                />
              </div>
            ) : null}

            {exportFormat !== "shapefiles" &&
            exportFormat !== "odc2026_shapefiles" &&
            exportFormat !== "qgis_project" &&
            validation &&
            validation.summary.error_count > 0 ? (
              <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs leading-4 text-warning">
                {t(
                  `There are ${validation.summary.error_count} validation error(s). The exported IMDF may not pass Apple's validation.`,
                  `${validation.summary.error_count} 件の検証エラーがあります。エクスポートされた IMDF は Apple の検証を通過しない可能性があります。`
                )}
              </p>
            ) : null}

            {(exportFormat === "shapefiles" ||
              exportFormat === "odc2026_shapefiles" ||
              exportFormat === "qgis_project") &&
            !hasGeoPackageSources ? (
              <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/40 p-4">
                <Field label={t("Encoding", "文字コード")}>
                  {(id) => (
                    <Select
                      value={shapefileEncoding}
                      onValueChange={(value) =>
                        setShapefileEncoding(value as ShapefileExportEncoding)
                      }
                    >
                      <SelectTrigger id={id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="preserve_source">
                          {t("Preserve source encoding", "元データの文字コードを維持")}
                        </SelectItem>
                        <SelectItem value="utf-8">UTF-8</SelectItem>
                        <SelectItem value="cp932">CP932 (Shift-JIS)</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </Field>

                {exportFormat === "odc2026_shapefiles" || exportFormat === "qgis_project" ? (
                  <Field
                    label={t("Export file prefix", "エクスポートファイルの接頭辞")}
                    required
                    hint={t(
                      `Prefixes every exported file, e.g. "${shapefileExportName.trim() || "TokyoSta"}_1_Floor".`,
                      `すべての書き出しファイルの接頭辞になります（例: "${shapefileExportName.trim() || "TokyoSta"}_1_Floor"）。`
                    )}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        required
                        invalid={Boolean(exportOptionsError) && !shapefileExportName.trim()}
                        value={shapefileExportName}
                        placeholder="TokyoSta"
                        onChange={(event) => {
                          const value = event.target.value;
                          setShapefileExportName(value);
                          if (value.trim()) {
                            setExportOptionsError(null);
                          }
                        }}
                      />
                    )}
                  </Field>
                ) : null}

                {exportFormat === "odc2026_shapefiles" ? (
                  <p className="text-xs leading-4 text-muted-foreground">
                    {t(
                      "Uses reviewed IMDF-schema features to generate Site, Building, Floor, Space, Fixture, Opening, Drawing, Facility, Occupant, and Segment shapefiles.",
                      "レビュー済みの IMDF スキーマ地物から Site・Building・Floor・Space・Fixture・Opening・Drawing・Facility・Occupant・Segment のシェープファイルを生成します。"
                    )}
                  </p>
                ) : null}

                {exportFormat === "qgis_project" ? (
                  <p className="text-xs leading-4 text-muted-foreground">
                    {t(
                      "Generates a styled QGIS .qgz project (floors grouped as layers, spaces colored by category) bundled with the ODC2026 shapefiles. Extract the zip and open the .qgz in QGIS.",
                      "階層ごとにレイヤをグループ化し、空間をカテゴリ別に色分けした QGIS プロジェクト (.qgz) を ODC2026 シェープファイルと一緒に zip で出力します。zip を展開して .qgz を QGIS で開いてください。"
                    )}
                  </p>
                ) : null}

                {exportFormat === "shapefiles" ? (
                  <details className="group">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium leading-[18px] text-muted-foreground transition-colors hover:text-foreground">
                      <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                      {t("Field names and legacy codes", "フィールド名と旧コード")}
                    </summary>

                    <div className="mt-4 flex flex-col gap-4">
                      <label className="flex cursor-pointer items-start gap-2 text-[13px] leading-[18px] text-foreground">
                        <Checkbox
                          className="mt-0.5"
                          checked={shapefileWriteCategoryToNewField}
                          onCheckedChange={(next) => {
                            const checked = next === true;
                            setShapefileWriteCategoryToNewField(checked);
                            if (checked) {
                              const sourceField = shapefileSourceCategoryField.trim().toLowerCase();
                              const currentField = shapefileCategoryField.trim().toLowerCase();
                              if (!currentField || (sourceField && currentField === sourceField)) {
                                setShapefileCategoryField("IMDF_CAT");
                              }
                              return;
                            }
                            const sourceField = shapefileSourceCategoryField.trim();
                            if (sourceField) {
                              setShapefileCategoryField(sourceField);
                            }
                          }}
                        />
                        <span>
                          {t(
                            "Write IMDF categories to a new field instead of overwriting the existing code/category field.",
                            "既存のコード/カテゴリ列を上書きせず、新しい列に IMDF カテゴリを書き込みます。"
                          )}
                        </span>
                      </label>

                      <Field
                        label={
                          shapefileWriteCategoryToNewField
                            ? t("New IMDF category field", "新しい IMDF カテゴリ列")
                            : t("Existing category/code field to overwrite", "上書きする既存のカテゴリ/コード列")
                        }
                        hint={
                          shapefileWriteCategoryToNewField
                            ? undefined
                            : t(
                                "Defaults to your mapped source column, so exports replace old codes with IMDF categories.",
                                "既定値は対応付け済みの元列で、旧コードを IMDF カテゴリに置き換えます。"
                              )
                        }
                      >
                        {(id) => (
                          <Input
                            id={id}
                            value={shapefileCategoryField}
                            onChange={(event) => setShapefileCategoryField(event.target.value)}
                            placeholder={
                              shapefileWriteCategoryToNewField
                                ? "IMDF_CAT"
                                : shapefileSourceCategoryField || "CATEGORY"
                            }
                          />
                        )}
                      </Field>

                      <Field label={t("Legacy code field (optional)", "旧コード列（任意）")}>
                        {(id) => (
                          <Input
                            id={id}
                            value={shapefileLegacyCodeField}
                            onChange={(event) => setShapefileLegacyCodeField(event.target.value)}
                            placeholder="COMPANY_CODE"
                          />
                        )}
                      </Field>

                      <Field
                        label={t("Legacy mappings (optional)", "旧コードの対応（任意）")}
                        hint={t(
                          "One per line as category=CODE. Applied only when a legacy code field is set.",
                          "1行に1つ、category=CODE の形式で。旧コード列を設定したときのみ適用されます。"
                        )}
                      >
                        {(id) => (
                          <Textarea
                            id={id}
                            className="font-mono text-xs"
                            rows={4}
                            value={shapefileLegacyMapText}
                            onChange={(event) => setShapefileLegacyMapText(event.target.value)}
                            placeholder={"room=B0001\noffice=B0002"}
                          />
                        )}
                      </Field>
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}

            {exportOptionsError ? (
              <p role="alert" className="text-xs leading-4 text-destructive">
                {exportOptionsError}
              </p>
            ) : null}

            {validation && validation.warnings.length > 0 ? (
              <div className="flex max-h-36 flex-col gap-1 overflow-auto rounded-md border border-warning/20 bg-warning/10 p-3 text-xs leading-4 text-warning">
                {validation.warnings.slice(0, 10).map((warning, index) => (
                  <p key={`${warning.check}-${index}`}>{warning.message}</p>
                ))}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>
              {t("Cancel", "キャンセル")}
            </Button>
            <Button onClick={() => void downloadExport()} disabled={exporting || exportBlocked}>
              {exporting
                ? t("Downloading…", "ダウンロード中…")
                : exportFormat === "shapefiles"
                  ? t("Download shapefiles .zip", "シェープファイル .zip をダウンロード")
                  : exportFormat === "odc2026_shapefiles"
                    ? t("Download ODC 2026 .zip", "オープンデータコンテスト2026 .zip をダウンロード")
                    : exportFormat === "qgis_project"
                      ? t("Download QGIS project .zip", "QGIS プロジェクト .zip をダウンロード")
                      : exportFormat === "imdf_zip"
                        ? t("Download .zip", ".zip をダウンロード")
                        : t("Download .imdf", ".imdf をダウンロード")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
