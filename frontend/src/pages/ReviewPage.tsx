import { PanelLeftOpen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  autofillWizardAddressFromGeometry,
  autofixSession,
  deleteSessionFeature,
  fetchFeatureTypeCatalog,
  fetchSessionFiles,
  fetchSessionFeatures,
  fetchStoredValidation,
  generateSessionDraft,
  patchFeaturesGuarded,
  patchSessionFeature,
  patchSessionFeaturesBulk,
  resolveSessionUnitOverlap,
  resolveSessionUnitOverlapsSafe,
  restoreSessionFeatures,
  snapOpening,
  type FeatureTypeOption,
  type FeatureUndo,
  validateSession,
  type ValidationIssue,
  type ValidationResponse} from "../api/client";
import { CheckRail } from "../components/check/CheckRail";
import { IssuePopover } from "../components/check/IssuePopover";
import { FloorSwitcher, MapToolbar } from "../components/check/MapChrome";
import { FilterBar, activeFilterCount } from "../components/review/FilterBar";
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
import { ErrorBoundary } from "../components/shared/ErrorBoundary";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast, useWithdrawToastActions } from "../components/shared/ToastProvider";
import { useSearchSource } from "../components/search/SearchContext";
import { canonicalFloor } from "../lib/search/parse";
import type { ApplyOutcome, ChangeCommand, CheckSource } from "../lib/search/source";
import { type ReviewFeature, featureLayerKey, featureName, layerKeyBaseType, orderedLayerKeys } from "../components/review/types";
import { isApiClientError } from "../api/errors";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  buildCheckView,
  featureLabel,
  findGroup,
  focusedIssue,
  issueAnchor,
  locateIssue,
  refocus,
  undoable,
  type DoneFix,
  type Focus
} from "../lib/check";
import { issueCopy } from "../lib/checkCopy";
import { projectPath, type Bilingual } from "../components/shell/stages";
import { useAppStore, useSessionAction } from "../store/useAppStore";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui";
import { usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { cn } from "@/lib/utils";


/** Only these feature types are visible by default on the map. */
const DEFAULT_VISIBLE_TYPES = new Set(["unit", "detail", "opening"]);

/** The layers the map toolbar offers as pills; every layer is in its layer list. */
const LAYER_PILLS: ReadonlyArray<[string, Bilingual]> = [
  ["unit", { en: "Units", ja: "ユニット" }],
  ["opening", { en: "Openings", ja: "開口部" }],
  ["fixture", { en: "Fixtures", ja: "什器" }],
  ["detail", { en: "Details", ja: "詳細" }]
];
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

/** Toasts whose Undo belongs to this page; withdrawn when it goes. */
const COMMAND_TOASTS = "check-command";

/** Radix Select has no empty-string value, so "no level chosen" needs one. */
const BULK_NO_LEVEL = "__none__";


export function ReviewPage() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId);
  const importProfile = useAppStore((state) => state.importProfile);
  const setImportProfile = useSessionAction(sessionId, (state) => state.setImportProfile);
  const setFiles = useSessionAction(sessionId, (state) => state.setFiles);
  const wizardState = useAppStore((state) => state.wizardState);
  const selectedFeatureIds = useAppStore((state) => state.selectedFeatureIds);
  const setSelectedFeatureIds = useSessionAction(sessionId, (state) => state.setSelectedFeatureIds);
  const toggleSelectedFeatureId = useSessionAction(sessionId, (state) => state.toggleSelectedFeatureId);
  const clearSelectedFeatureIds = useSessionAction(sessionId, (state) => state.clearSelectedFeatureIds);
  const filters = useAppStore((state) => state.filters);
  const setFilters = useSessionAction(sessionId, (state) => state.setFilters);
  const setValidationResults = useSessionAction(sessionId, (state) => state.setValidationResults);
  const layerVisibility = useAppStore((state) => state.layerVisibility);
  const setLayerVisibility = useSessionAction(sessionId, (state) => state.setLayerVisibility);
  const pushEditHistory = useSessionAction(sessionId, (state) => state.pushEditHistory);
  const popEditHistory = useAppStore((state) => state.popEditHistory);

  const handleApiError = useApiErrorHandler(sessionId);
  const { t } = useUiLanguage();
  const pushToast = useToast();
  const withdrawToastActions = useWithdrawToastActions();
  const [searchParams, setSearchParams] = useSearchParams();

  const [features, setFeatures] = useState<ReviewFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
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
  const [fixing, setFixing] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [done, setDone] = useState<DoneFix[]>([]);
  const [checksStale, setChecksStale] = useState(false);
  const [railHidden, setRailHidden] = useState(false);
  const [mainView, setMainView] = useState<"map" | "table">("map");
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [contentRev, setContentRev] = useState<number | null>(null);
  const [previewIds, setPreviewIds] = useState<readonly string[] | null>(null);
  const nextDoneId = useRef(0);
  const doneRef = useRef<DoneFix[]>([]);
  doneRef.current = done;

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
      setContentRev(typeof response.content_rev === "number" ? response.content_rev : null);
      return rows;
    } catch (caught) {
      captureError(caught, t("Failed to load review data", "レビュー データの読み込みに失敗しました"), t("Review load failed", "レビュー読み込み失敗"));
      return [];
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  };

  // The stored validation is reused while nothing has changed since it ran;
  // otherwise Check runs the checker itself, so the to-do list is never empty
  // just because nobody pressed a button.
  useEffect(() => {
    if (!sessionId) return;
    void loadFeatures().then(async () => {
      try {
        const stored = await fetchStoredValidation(sessionId);
        if (stored) applyPostValidationState(stored);
        else await runValidation({ quiet: true });
      } catch (caught) {
        captureError(caught, t("Could not read the checks", "チェック結果を読み込めませんでした"), t("Check failed", "チェック失敗"));
      }
    });
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
      afterEdit();
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
      afterEdit();
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
      afterEdit();
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
      afterEdit();
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
      afterEdit();
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
      afterEdit();
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
      afterEdit();
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

  const featuresById = useMemo(() => new Map(features.map((item) => [item.id, item])), [features]);
  const checkView = useMemo(() => buildCheckView(validation, features, floorOptions), [validation, features, floorOptions]);
  const activeIssue = focusedIssue(checkView, focus);
  const floorsWithIssues = useMemo(
    () => ({
      must: new Set(checkView.mustFix.flatMap((group) => group.floors)),
      wait: new Set(checkView.canWait.flatMap((group) => group.floors))
    }),
    [checkView]
  );

  useEffect(() => {
    setFocus((current) => refocus(checkView, current));
  }, [checkView]);

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
    const target = featuresById.get(targetId);
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
  }, [activeIssue, featuresById, floorOptions, mapFloorFilter]);

  /** Opens an issue on the map, switching its layer on when that layer is hidden. */
  const openIssue = (next: Focus) => {
    const issue = focusedIssue(checkView, next);
    if (!issue) return;
    const hidden = [issue.feature_id, issue.related_feature_id]
      .map((id) => (id ? featuresById.get(id) : undefined))
      .filter((item): item is ReviewFeature => Boolean(item?.geometry))
      .map(featureLayerKey)
      .filter((key) => layerVisibility[key] === false);
    if (hidden.length > 0) {
      setLayerVisibility({ ...layerVisibility, ...Object.fromEntries(hidden.map((key) => [key, true])) });
    }
    setMainView("map");
    setFocus(next);
  };

  /** Any edit that is not a fix: the stored checks no longer describe the project, and undoing a fix could undo it. */
  const afterEdit = () => {
    setChecksStale(true);
    setDone((previous) => previous.map((entry) => ({ ...entry, stale: true })));
  };

  const applyPostValidationState = (next: ValidationResponse) => {
    setChecksStale(false);
    setValidation(next);
    setValidationResults({
      errors: next.summary.error_count,
      warnings: next.summary.warning_count
    });
  };

  const runValidation = async ({ quiet = false } = {}): Promise<ValidationResponse | null> => {
    if (!sessionId) {
      return null;
    }
    setValidating(true);
    setError(null);
    try {
      const response = await validateSession(sessionId);
      applyPostValidationState(response);
      await loadFeatures();
      if (!quiet) {
        pushToast({
          title: t("Validation complete", "検証が完了しました"),
          description: t(
            `${response.summary.error_count} errors, ${response.summary.warning_count} warnings.`,
            `エラー ${response.summary.error_count} 件、警告 ${response.summary.warning_count} 件。`
          ),
          variant: response.summary.error_count > 0 ? "info" : "success"
        });
      }
      return response;
    } catch (caught) {
      captureError(caught, t("Validation failed", "検証に失敗しました"), t("Validation failed", "検証失敗"));
      return null;
    } finally {
      setValidating(false);
    }
  };

  /**
   * Every fix goes through here: it applies the revalidation the fix returns,
   * reloads the features, and records the fix with what undoes it.
   */
  const applyFix = async (
    request: () => Promise<{ validation: ValidationResponse; undo: FeatureUndo } | null>,
    label: Bilingual,
    failure: Bilingual
  ) => {
    if (!sessionId) return;
    setFixing(true);
    setError(null);
    try {
      const result = await request();
      if (!result) return;
      await recordFix(result, label);
      const left = result.validation.summary.error_count;
      pushToast({
        title: t(`Fixed: ${label.en}`, `修正しました：${label.ja}`),
        description: t(`${left} left to fix.`, `残り ${left} 件。`),
        variant: "success"
      });
    } catch (caught) {
      captureError(caught, t(failure.en, failure.ja), t(failure.en, failure.ja));
    } finally {
      setFixing(false);
    }
  };

  /** What every fix does once the server has answered: show its checks, reload, and keep its undo. */
  const recordFix = async (result: { validation: ValidationResponse; undo: FeatureUndo }, label: Bilingual) => {
    applyPostValidationState(result.validation);
    await loadFeatures();
    if (result.undo.features.length === 0 && result.undo.remove_ids.length === 0) return null;
    nextDoneId.current += 1;
    const entry: DoneFix = { id: nextDoneId.current, label, undo: result.undo };
    setDone((previous) => [...previous, entry]);
    return entry;
  };

  /** A typed command's change, guarded by the revision its preview was read at. */
  const applyCommand = async (command: ChangeCommand, basis: number): Promise<ApplyOutcome> => {
    if (!sessionId) return { kind: "failed" };
    setFixing(true);
    setError(null);
    try {
      let result: { validation: ValidationResponse; undo: FeatureUndo };
      let label: Bilingual | null;
      if (command.verb === "assign") {
        const properties: Record<string, unknown> = { ordinal: command.to.ordinal, short_name: command.to.shortName };
        if (command.outdoor !== "keep") properties.outdoor = command.outdoor === "set";
        const response = await patchFeaturesGuarded(sessionId, [command.level.id], properties, basis);
        result = response;
        label =
          response.updated_count > 0
            ? { en: `Moved ${command.level.name} to ${command.to.label}`, ja: `${command.level.name}を${command.to.label}に移動` }
            : null;
      } else {
        const response = await resolveSessionUnitOverlapsSafe(sessionId, basis);
        result = response;
        const waiting = response.skipped_count;
        label =
          response.resolved_pairs > 0
            ? {
                en: `Trimmed ${response.resolved_pairs} overlap${response.resolved_pairs === 1 ? "" : "s"}${waiting > 0 ? ` · ${waiting} need${waiting === 1 ? "s" : ""} your choice` : ""}`,
                ja: `重なりを ${response.resolved_pairs} 件解消${waiting > 0 ? ` · ${waiting} 件は選択が必要` : ""}`
              }
            : null;
      }
      const entry = await recordFix(result, label ?? { en: "Nothing changed", ja: "変更なし" });
      if (!label || !entry) {
        pushToast({ title: t("Nothing changed", "変更はありませんでした"), variant: "info" });
        return { kind: "done" };
      }
      pushToast({
        title: t(`${label.en}.`, `${label.ja}。`),
        description: t(
          `${result.validation.summary.error_count} left to fix.`,
          `残り ${result.validation.summary.error_count} 件。`
        ),
        variant: "success",
        durationMs: 8000,
        group: COMMAND_TOASTS,
        action: {
          label: t("Undo", "元に戻す"),
          run: () => {
            const current = doneRef.current.find((item) => item.id === entry.id);
            if (current && !current.stale && undoable(doneRef.current, current)) void undoFix(current);
            else
              pushToast({
                title: t("Can’t undo — changed since", "元に戻せません — その後に変更されています"),
                variant: "info"
              });
          }
        }
      });
      return { kind: "done" };
    } catch (caught) {
      if (isApiClientError(caught) && caught.code === "REVISION_STALE") {
        await loadFeatures();
        return { kind: "stale" };
      }
      captureError(caught, t("The command failed", "コマンドに失敗しました"), t("The command failed", "コマンドに失敗しました"));
      return { kind: "failed" };
    } finally {
      setFixing(false);
    }
  };

  const undoFix = async (entry: DoneFix) => {
    if (!sessionId) return;
    setFixing(true);
    setError(null);
    try {
      applyPostValidationState(await restoreSessionFeatures(sessionId, entry.undo));
      await loadFeatures();
      setDone((previous) => previous.filter((item) => item.id !== entry.id));
      pushToast({ title: t(`Undone: ${entry.label.en}`, `元に戻しました：${entry.label.ja}`), variant: "success" });
    } catch (caught) {
      if (isApiClientError(caught) && (caught.code === "UNDO_STALE" || caught.code === "UNDO_INVALID")) {
        setDone((previous) => previous.filter((item) => item.id !== entry.id));
        setChecksStale(true);
        pushToast({
          title: t("Can’t undo — changed since", "元に戻せません — その後に変更されています"),
          description: t(
            `Something the fix touched was edited after it (${entry.label.en}), so undoing it would overwrite that edit.`,
            `修正（${entry.label.ja}）の後に対象が編集されたため、元に戻すとその編集を上書きしてしまいます。`
          ),
          variant: "info"
        });
      } else {
        captureError(caught, t("Undo failed", "元に戻せませんでした"), t("Undo failed", "元に戻せませんでした"));
      }
    } finally {
      setFixing(false);
    }
  };

  const nameOf = (id: string) => featureLabel(featuresById.get(id), wizardState?.project?.language ?? "en");

  /** Safe fixes first; the ones that delete or fill are asked about and recorded as a fix of their own. */
  const runAutofix = async () => {
    let prompted = 0;
    const failure = { en: "Auto-fix failed", ja: "自動修正に失敗しました" };
    await applyFix(
      async () => {
        const response = await autofixSession(sessionId!, false);
        prompted = response.total_requiring_confirmation;
        return { validation: response.revalidation, undo: response.undo };
      },
      { en: "automatic fixes applied", ja: "自動修正を適用" },
      failure
    );
    if (
      prompted > 0 &&
      window.confirm(
        t(
          `${prompted} fixes delete a feature or fill a hole. Apply them too?`,
          `${prompted} 件の修正はフィーチャーの削除または穴埋めを行います。これらも適用しますか？`
        )
      )
    ) {
      await applyFix(
        async () => {
          const response = await autofixSession(sessionId!, true);
          return { validation: response.revalidation, undo: response.undo };
        },
        { en: "features deleted or holes filled", ja: "フィーチャーの削除・穴埋め" },
        failure
      );
    }
  };

  const resolveOverlapPair = (keepFeatureId: string, clipFeatureId: string) => {
    const kept = nameOf(keepFeatureId);
    return applyFix(
      async () => {
        const response = await resolveSessionUnitOverlap(sessionId!, keepFeatureId, clipFeatureId);
        if (response.deleted_count > 0) {
          setSelectedFeatureIds(selectedFeatureIds.filter((item) => item !== clipFeatureId));
        }
        return response;
      },
      { en: `overlap resolved — kept ${kept.en}`, ja: `重なりを解消 — ${kept.ja}を残す` },
      { en: "Failed to resolve overlap", ja: "重なりの解消に失敗しました" }
    );
  };

  const handleSnapOpening = (openingId: string, unitId: string) => {
    const unit = nameOf(unitId);
    return applyFix(
      () => snapOpening(sessionId!, openingId, unitId),
      { en: `door snapped to ${unit.en}`, ja: `開口部を${unit.ja}にスナップ` },
      { en: "Failed to snap opening", ja: "開口部のスナップに失敗しました" }
    );
  };

  const resolveSafeOverlaps = () =>
    applyFix(
      async () => {
        const response = await resolveSessionUnitOverlapsSafe(sessionId!);
        if (response.skipped_count > 0) {
          pushToast({
            title: t(`${response.skipped_count} overlaps need your choice`, `${response.skipped_count} 件の重なりは選択が必要です`),
            variant: "info"
          });
        }
        return response;
      },
      { en: "clear-cut overlaps trimmed", ja: "はっきりした重なりを解消" },
      { en: "Failed to apply safe overlap fix", ja: "安全な重なり修正の適用に失敗しました" }
    );

  const deliverBusy = validating || loading || fixing;
  const goToDeliver = () => {
    if (sessionId) navigate(projectPath(sessionId, "deliver"));
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
            afterEdit();
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
        setFocus(null);
        return;
      }

      // Ctrl+E → Deliver
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e" && !isFormTarget(event.target)) {
        event.preventDefault();
        if (!deliverBusy) goToDeliver();
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
  }, [clearSelectedFeatureIds, deliverBusy, popEditHistory, sessionId, validating, validation]);

  usePrimaryAction({
    label: t("Deliver", "書き出し"),
    run: goToDeliver,
    disabledReason: deliverBusy ? t("Wait for the current task to finish", "処理の完了をお待ちください") : null,
    busy: deliverBusy,
    blockers: (!checksStale && validation?.summary.error_count) || null
  });
  usePageShell({
    checkErrors: validation && !checksStale ? validation.summary.error_count : null,
    checkWarnings: validation && !checksStale ? validation.summary.warning_count : null
  });

  const language = wizardState?.project?.language ?? "en";

  const showFloor = (label: string) => {
    const wanted = canonicalFloor(label);
    const floor = floorOptions.find((item) => item.id === label || canonicalFloor(item.label) === wanted);
    if (!floor) return false;
    setMainView("map");
    setMapFloorFilter(floor.id);
    return true;
  };

  const showLevel = (levelId: string) => {
    const floor = floorOptions.find((item) => item.levelIds.includes(levelId));
    setMainView("map");
    if (floor) setMapFloorFilter(floor.id);
    setSelectedFeatureIds([levelId]);
  };

  const searchHandlers = useRef({ openIssue, showFloor, showLevel, runValidation, applyCommand });
  searchHandlers.current = { openIssue, showFloor, showLevel, runValidation, applyCommand };
  const currentValidation = checksStale ? null : validation;
  const searchSource = useMemo<CheckSource | null>(
    () =>
      sessionId
        ? {
            snapshot: {
              sessionId,
              contentRev,
              features,
              validation: currentValidation,
              view: checkView,
              floors: floorOptions,
              language
            },
            openIssue: (next) => searchHandlers.current.openIssue(next),
            showFloor: (label) => {
              searchHandlers.current.showFloor(label);
            },
            showLevel: (levelId) => searchHandlers.current.showLevel(levelId),
            runChecks: () => void searchHandlers.current.runValidation(),
            showPreview: setPreviewIds,
            apply: (command, basis) => searchHandlers.current.applyCommand(command, basis)
          }
        : null,
    [sessionId, contentRev, features, currentValidation, checkView, floorOptions, language]
  );
  useSearchSource(searchSource);

  useEffect(() => () => withdrawToastActions(COMMAND_TOASTS), [sessionId, withdrawToastActions]);

  // Search opens Check at a floor (?floor=1F) or at the next must-fix issue
  // (?issue=next); each hint is read once and then dropped from the URL.
  useEffect(() => {
    const floor = searchParams.get("floor");
    if (!floor || floorOptions.length === 0) return;
    if (!showFloor(floor)) {
      pushToast({ title: t(`No floor ${floor} in this project`, `このプロジェクトに ${floor} はありません`), variant: "info" });
    }
    const next = new URLSearchParams(searchParams);
    next.delete("floor");
    setSearchParams(next, { replace: true });
  }, [floorOptions, searchParams]);

  useEffect(() => {
    if (searchParams.get("issue") !== "next" || !validation) return;
    const first = checkView.mustFix[0];
    if (first) openIssue({ key: first.key, index: 0 });
    const next = new URLSearchParams(searchParams);
    next.delete("issue");
    setSearchParams(next, { replace: true });
  }, [checkView, validation, searchParams]);
  const focusGroup = focus ? findGroup(checkView, focus.key) : undefined;
  const focusAnchor = activeIssue ? issueAnchor(activeIssue, featuresById) : null;
  const focusNumber = focusGroup?.mustFix ? checkView.mustFix.indexOf(focusGroup) + 1 : null;
  const issuePin =
    activeIssue && focusAnchor
      ? {
          lngLat: focusAnchor,
          content: (
            <span
              aria-hidden="true"
              className={cn(
                "flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 border-card text-xs font-semibold shadow",
                focusNumber === null ? "bg-warning text-card" : "bg-destructive text-destructive-foreground"
              )}
            >
              {focusNumber ?? "!"}
            </span>
          )
        }
      : null;
  const issuePopover =
    activeIssue && focus && focusGroup ? (
      <div className="absolute right-5 top-[76px] z-10 max-h-[calc(100%-120px)] overflow-y-auto rounded-2xl">
        <IssuePopover
          issue={activeIssue}
          number={focusNumber}
          position={{ index: focus.index, count: focusGroup.issues.length }}
          featuresById={featuresById}
          language={language}
          busy={fixing}
          onStep={(delta) => openIssue({ key: focus.key, index: focus.index + delta })}
          onClose={() => setFocus(null)}
          onKeep={(keep, trim) => void resolveOverlapPair(keep, trim)}
          onFixClearOverlaps={() => void resolveSafeOverlaps()}
          onSnap={(opening, unit) => void handleSnapOpening(opening, unit)}
          onEdit={(featureId) => setSelectedFeatureIds([featureId])}
        />
      </div>
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        {railHidden ? null : (
          <CheckRail
            view={checkView}
            validated={validation !== null}
            stale={checksStale}
            checking={validating}
            busy={fixing || validating}
            done={done}
            focusKey={focus?.key ?? null}
            featuresById={featuresById}
            language={language}
            onFocus={(key) => openIssue(focus?.key === key ? focus : { key, index: 0 })}
            onUndo={(entry) => void undoFix(entry)}
            onCheckAgain={() => void runValidation()}
            onAutoFix={() => void runAutofix()}
            onHide={() => setRailHidden(true)}
          >
            {importProfile === "imdf_shapefile" ? (
              <VenueDetailsPanel
                venue={venueFeature}
                building={buildingFeature}
                address={addressFeature}
                language={language}
                onSave={(featureId, properties) => void saveFeatureProperties(featureId, properties)}
                onRequestAutofill={requestAddressAutofill}
              />
            ) : null}
          </CheckRail>
        )}

        {/* The map stays mounted behind the table rather than unmounting on
            every view switch: rebuilding a MapLibre instance throws away the
            tiles, the camera and the fitted bounds. */}
        <div className="relative min-w-0 flex-1">
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
            {loading && !loadedOnce ? (
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
                  pin={issuePin}
                  previewIds={previewIds}
                  onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
                />
              </ErrorBoundary>
            )}
            {floorOptions.length > 0 ? (
              <FloorSwitcher
                floors={floorOptions}
                value={mapFloorFilter ?? ""}
                mustFix={floorsWithIssues.must}
                canWait={floorsWithIssues.wait}
                onChange={setMapFloorFilter}
              />
            ) : null}
            {issuePopover}
          </div>

          {mainView === "table" ? (
            <div className="absolute inset-0 flex flex-col gap-3 overflow-auto bg-muted px-3 pb-3 pt-[76px]">
              <div className="flex items-end justify-between gap-3">
                <FilterBar
                  filters={filters}
                  featureTypes={filterFeatureTypes}
                  levels={levelOptions}
                  categories={filterCategories}
                  onChange={(next) => setFilters(next)}
                />
                <span className="shrink-0 pb-2 font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                  {filterCount > 0
                    ? t(
                        `${filteredFeatures.length} of ${features.length} features`,
                        `${features.length} 件中 ${filteredFeatures.length} 件`
                      )
                    : t(`${features.length} features`, `${features.length} 件`)}
                </span>
              </div>
              <TablePanel
                features={filteredFeatures}
                levelOptions={levelOptions}
                issuesByFeature={issuesByFeature}
                selectedFeatureIds={selectedFeatureIds}
                onSelectFeature={(id, multi) => toggleSelectedFeatureId(id, multi)}
                onSelectionChange={(ids) => setSelectedFeatureIds(ids)}
              />
            </div>
          ) : null}

          {railHidden ? (
            <Button
              variant="outline"
              size="sm"
              className={cn("absolute z-10 bg-card", mainView === "map" && floorOptions.length > 0 ? "bottom-8 left-5" : "left-5 top-5")}
              onClick={() => setRailHidden(false)}
            >
              <PanelLeftOpen />
              {checkView.blockers > 0
                ? t(`To-do · ${checkView.blockers}`, `ToDo · ${checkView.blockers}`)
                : t("To-do", "ToDo")}
            </Button>
          ) : null}

          <MapToolbar
            view={mainView}
            onView={setMainView}
            layers={LAYER_PILLS.filter(([key]) => layerKeys.includes(key)).map(([key, label]) => ({
              key,
              label: t(label.en, label.ja),
              on: layerVisibility[key] ?? true
            }))}
            onToggleLayer={(key) => setLayerVisibility({ ...layerVisibility, [key]: !(layerVisibility[key] ?? true) })}
            allLayers={
              <LayerTree
                featureTypes={layerKeys}
                layerVisibility={layerVisibility}
                validationLoaded={validation !== null}
                overlayVisibility={overlayVisibility}
                showBasemap={showBasemap}
                onLayerVisibilityChange={setLayerVisibility}
                onOverlayVisibilityChange={setOverlayVisibility}
                onShowBasemapChange={setShowBasemap}
              />
            }
          />
        </div>

        {/* ── Right sidebar: bulk actions and properties ── */}
        {rightSidebarOpen && selectedFeature ? (
          <aside
            className="flex flex-col overflow-y-auto border-l border-border bg-card"
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
            {selectedFeatureIds.length > 1 ? (
              <div className="shrink-0 border-b border-border bg-muted p-2.5">
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
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
              {selectedFeatureIssues.length > 0 ? (
                <section aria-label={t("Issues on this feature", "このフィーチャーの問題")} className="flex flex-col gap-1.5">
                  <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                    {t("Issues on this feature", "このフィーチャーの問題")}
                  </h3>
                  {selectedFeatureIssues.map((issue, index) => {
                    const copy = issueCopy(issue.check);
                    const where = locateIssue(checkView, issue);
                    return (
                      <button
                        key={`${issue.check}-${index}`}
                        type="button"
                        disabled={!where}
                        onClick={() => where && openIssue(where)}
                        className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-default"
                      >
                        <span
                          aria-hidden="true"
                          className={cn("h-2 w-2 shrink-0 rounded-full", issue.severity === "error" ? "bg-destructive" : "bg-warning")}
                        />
                        <span className="min-w-0 flex-1 text-foreground">{t(copy.title.en, copy.title.ja)}</span>
                        {where ? <span className="shrink-0 text-primary">{t("Open →", "開く →")}</span> : null}
                      </button>
                    );
                  })}
                </section>
              ) : null}
              <PropertiesPanel
                feature={selectedFeature}
                language={language}
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
    </div>
  );
}
