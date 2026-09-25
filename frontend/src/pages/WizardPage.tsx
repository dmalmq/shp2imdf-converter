import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  autofillWizardAddressFromGeometry,
  detectAllFiles,
  fetchSessionFeatures,
  fetchSessionFiles,
  fetchWizardState,
  generateSessionDraft,
  patchWizardBuildings,
  patchWizardFootprint,
  patchWizardLevels,
  patchWizardMappings,
  patchWizardProject,
  type BuildingWizardState,
  type FixtureMappingState,
  type FootprintWizardState,
  type LevelWizardItem,
  type OpeningMappingState,
  type ProjectWizardState,
  searchWizardAddress,
  type GeocodeResultItem,
  type UnitMappingState,
  type UpdateFileRequest,
  updateSessionFile,
  uploadCompanyMappings
} from "../api/client";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast } from "../components/shared/ToastProvider";
import { BuildingStep, canSaveBuildings, normalizeBuildingsForSave } from "../components/wizard/BuildingStep";
import { DetailMapStep } from "../components/wizard/DetailMapStep";
import { FileClassStep } from "../components/wizard/FileClassStep";
import { FixtureMapStep } from "../components/wizard/FixtureMapStep";
import { FootprintStep } from "../components/wizard/FootprintStep";
import { LevelMapStep } from "../components/wizard/LevelMapStep";
import { OpeningMapStep } from "../components/wizard/OpeningMapStep";
import { ProjectInfoStep, isProjectComplete, normalizeProjectForSave } from "../components/wizard/ProjectInfoStep";
import { SectionNav, type SectionDef } from "../components/wizard/SectionNav";
import { SummaryStep } from "../components/wizard/SummaryStep";
import { UnitMapStep } from "../components/wizard/UnitMapStep";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore, useSessionAction, type WizardDrafts } from "../store/useAppStore";
import { Button, DisabledHint } from "../components/ui";
import { useInShell, usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { projectPath } from "../components/shell/stages";
import { LEVEL_REQUIRED_TYPES } from "../lib/bringIn";
import { formatClock } from "../lib/clock";
import { WizardFooterProvider, sameAsSaved, useAutosave, useWizardFooterState } from "../components/wizard/wizardSave";


const EMPTY_UNIT_MAPPING: UnitMappingState = {
  code_column: null,
  name_column: null,
  alt_name_column: null,
  restriction_column: null,
  accessibility_column: null,
  available_categories: [],
  preview: []
};

const EMPTY_OPENING_MAPPING: OpeningMappingState = {
  category_column: null,
  accessibility_column: null,
  access_control_column: null,
  door_automatic_column: null,
  door_material_column: null,
  door_type_column: null,
  name_column: null
};

const EMPTY_FIXTURE_MAPPING: FixtureMappingState = {
  name_column: null,
  alt_name_column: null,
  category_column: null
};

const EMPTY_FOOTPRINT: FootprintWizardState = {
  method: "union_buffer",
  footprint_buffer_m: 0,
  venue_buffer_m: 0,
  level_gap_fill_m: 0.1
};

const SECTION_HELP: Record<string, { en: string; ja: string }> = {
  project: {
    en: "Set venue basics like name, category, and address. These become your IMDF venue and address records.",
    ja: "会場名・カテゴリ・住所などの基本情報を設定します。"
  },
  building: {
    en: "Group level files into buildings and optionally define building-specific addresses.",
    ja: "レベルファイルを建物ごとに割り当てます。"
  },
  footprint: {
    en: "Pick how footprint and venue outlines are derived from your source geometry.",
    ja: "元データから footprint / venue 外形を作る方法を選択します。"
  },
  files: {
    en: "Confirm each source file type. Correct classification keeps later mapping accurate.",
    ja: "各ファイルの種別を確認します。"
  },
  levels: {
    en: "Set floor levels and names so every feature is assigned to the correct level.",
    ja: "各ファイルの階層（レベル）と名称を設定します。"
  },
  unit: {
    en: "Choose how unit attributes map to IMDF categories and names.",
    ja: "ユニット属性を IMDF カテゴリや名称へ対応付けます。"
  },
  opening: {
    en: "Map opening attributes such as category, door type, and accessibility-related fields.",
    ja: "opening のカテゴリ、ドア種別、アクセシビリティ項目などの対応付けを行います。"
  },
  fixture: {
    en: "Map fixture names and categories for non-unit physical objects.",
    ja: "fixture（設備）の名称とカテゴリを対応付けます。"
  },
  detail: {
    en: "Detail features are exported as lightweight line features linked to levels only.",
    ja: "detail は level のみを持つ軽量な線要素として出力されます。"
  },
  "project-info": {
    en: "Set venue basics like name, category, and address. These become your IMDF venue and address records.",
    ja: "会場名・カテゴリ・住所などの基本情報を設定します。"
  },
  attributes: {
    en: "Map source attribute columns onto IMDF fields, one feature type at a time.",
    ja: "元データの属性列を IMDF の項目へ、フィーチャー種別ごとに対応付けます。"
  },
  summary: {
    en: "Review configuration, then generate draft IMDF features and continue to review.",
    ja: "設定内容を最終確認し、ドラフト生成してレビュー画面へ進みます。"
  }
};

function toLevelItemsFromFiles(
  files: {
    stem: string;
    detected_type: string | null;
    detected_level: number | null;
    level_name: string | null;
    short_name: string | null;
    outdoor: boolean;
    level_category: string;
  }[]
): LevelWizardItem[] {
  return files
    .filter((item) => LEVEL_REQUIRED_TYPES.has(item.detected_type ?? ""))
    .map((item) => ({
      stem: item.stem,
      detected_type: item.detected_type,
      ordinal: item.detected_level,
      name: item.level_name,
      short_name: item.short_name,
      outdoor: item.outdoor,
      category: item.level_category
    }));
}

/** Enter on a focused control belongs to that control, not the page's shortcut. */
function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    tag === "button" ||
    tag === "a" ||
    target.isContentEditable
  );
}

function WizardStepSkeleton() {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <SkeletonBlock className="h-6 w-56" />
      <div className="mt-4 space-y-3">
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-40 w-full" />
      </div>
    </section>
  );
}


export function WizardPage() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId);
  const setCurrentScreen = useSessionAction(sessionId, (state) => state.setCurrentScreen);
  const files = useAppStore((state) => state.files);
  const cleanupSummary = useAppStore((state) => state.cleanupSummary);
  const wizardState = useAppStore((state) => state.wizardState);
  const setFiles = useSessionAction(sessionId, (state) => state.setFiles);
  const setWizardState = useSessionAction(sessionId, (state) => state.setWizardState);
  const selectedFileStem = useAppStore((state) => state.selectedFileStem);
  const setSelectedFileStem = useAppStore((state) => state.setSelectedFileStem);
  const hoveredFileStem = useAppStore((state) => state.hoveredFileStem);
  const setHoveredFileStem = useAppStore((state) => state.setHoveredFileStem);
  const wizardSaveStatus = useAppStore((state) => state.wizardSaveStatus);
  const wizardSaveError = useAppStore((state) => state.wizardSaveError);
  const setWizardSaveStatus = useSessionAction(sessionId, (state) => state.setWizardSaveStatus);
  const wizardSavedAt = useAppStore((state) => state.wizardSavedAt);
  const wizardSaveRetry = useAppStore((state) => state.wizardSaveRetry);
  const learningSuggestion = useAppStore((state) => state.learningSuggestion);
  const setLearningSuggestion = useSessionAction(sessionId, (state) => state.setLearningSuggestion);
  const setSessionExpiredMessage = useSessionAction(sessionId, (state) => state.setSessionExpiredMessage);
  const handleApiError = useApiErrorHandler(sessionId);
  const pushToast = useToast();
  const { t, isJapanese } = useUiLanguage();

  const [activeSection, setActiveSection] = useState("project");
  const { action: footerAction, setAction: setFooterAction } = useWizardFooterState();
  // The form sections' edits live in the store rather than in the steps so
  // they outlive a section switch: a draft the backend cannot take yet (a venue
  // without its required fields) is still on screen when the operator returns.
  const { project: projectDraft, buildings: buildingsDraft, footprint: footprintDraft } = useAppStore(
    (state) => state.wizardDrafts
  );
  const setWizardDraft = useSessionAction(sessionId, (state) => state.setWizardDraft);
  const [loading, setLoading] = useState(false);
  const [features, setFeatures] = useState<
    {
      type: string;
      feature_type?: string;
      geometry?: { type: string; coordinates: unknown } | null;
      properties?: { source_file?: string; [key: string]: unknown };
    }[]
  >([]);

  const hasOpeningFiles = useMemo(() => files.some((f) => f.detected_type === "opening"), [files]);
  const hasFixtureFiles = useMemo(() => files.some((f) => f.detected_type === "fixture"), [files]);
  const hasDetailFiles = useMemo(() => files.some((f) => f.detected_type === "detail"), [files]);
  const hasUnitFiles = useMemo(() => files.some((f) => f.detected_type === "unit"), [files]);
  const allFileStems = useMemo(() => files.map((f) => f.stem), [files]);

  const project = projectDraft ?? wizardState?.project ?? null;
  const buildings = buildingsDraft ?? wizardState?.buildings ?? [];
  const footprint = footprintDraft ?? wizardState?.footprint ?? EMPTY_FOOTPRINT;
  const projectHeld = projectDraft !== null && !isProjectComplete(projectDraft);
  const buildingsHeld = buildingsDraft !== null && !canSaveBuildings(buildingsDraft, allFileStems);

  // ─── Validation ─────────────────────────────────────────────────────

  const projectComplete = isProjectComplete(project);

  const allClassified = useMemo(() => files.every((f) => Boolean(f.detected_type)), [files]);

  const levelsComplete = useMemo(() => {
    const required = files.filter((f) => LEVEL_REQUIRED_TYPES.has(f.detected_type ?? ""));
    return required.length === 0 || required.every((f) => f.detected_level !== null);
  }, [files]);

  const buildingsComplete = useMemo(() => {
    const required = files.filter((f) => LEVEL_REQUIRED_TYPES.has(f.detected_type ?? ""));
    if (required.length === 0) return true;
    if (buildingsHeld || buildings.length === 0) return false;
    const assigned = new Set(buildings.flatMap((b) => b.file_stems));
    const allAssigned = required.every((f) => assigned.has(f.stem));
    const venueName = project?.venue_name?.trim();
    const allNamed = buildings.every((b) => Boolean(b.name?.trim() || venueName));
    const addressesValid = buildings.every((b) => {
      if (b.address_mode !== "different_address") return true;
      return Boolean(b.address?.locality?.trim() && b.address?.country?.trim());
    });
    return allAssigned && allNamed && addressesValid;
  }, [files, buildings, buildingsHeld, project]);

  const unitMappingComplete = useMemo(
    () => !hasUnitFiles || Boolean(wizardState?.mappings.unit.code_column),
    [hasUnitFiles, wizardState]
  );

  const projectSectionValid = projectComplete && buildingsComplete;
  const attributeSectionValid = unitMappingComplete;
  const canGenerate = projectSectionValid && allClassified && levelsComplete && attributeSectionValid;

  // ─── Section definitions ────────────────────────────────────────────

  const sections: SectionDef[] = useMemo(
    () => [
      {
        id: "project",
        labelEn: "Project & Venue",
        labelJa: "プロジェクト & 会場",
        valid: projectSectionValid,
        children: [
          { id: "project-info", labelEn: "Venue Info", labelJa: "会場情報", valid: projectComplete },
          { id: "building", labelEn: "Buildings", labelJa: "建物", valid: buildingsComplete },
          { id: "footprint", labelEn: "Footprint", labelJa: "Footprint", valid: true }
        ]
      },
      {
        id: "files",
        labelEn: "File Classification",
        labelJa: "ファイル分類",
        valid: allClassified
      },
      {
        id: "levels",
        labelEn: "Level Mapping",
        labelJa: "レベル対応付け",
        valid: levelsComplete
      },
      {
        id: "attributes",
        labelEn: "Attribute Mapping",
        labelJa: "属性対応付け",
        valid: attributeSectionValid,
        children: [
          { id: "unit", labelEn: "Unit Mapping", labelJa: "Unit 対応付け", valid: unitMappingComplete, hidden: !hasUnitFiles },
          { id: "opening", labelEn: "Opening Mapping", labelJa: "Opening 対応付け", valid: true, hidden: !hasOpeningFiles },
          { id: "fixture", labelEn: "Fixture Mapping", labelJa: "Fixture 対応付け", valid: true, hidden: !hasFixtureFiles },
          { id: "detail", labelEn: "Detail Mapping", labelJa: "Detail 設定", valid: true, hidden: !hasDetailFiles }
        ]
      },
      {
        id: "summary",
        labelEn: "Summary & Generate",
        labelJa: "概要 & 生成",
        valid: projectSectionValid && allClassified && levelsComplete && attributeSectionValid
      }
    ],
    [
      projectSectionValid, projectComplete, buildingsComplete, allClassified,
      levelsComplete, attributeSectionValid, unitMappingComplete,
      hasUnitFiles, hasOpeningFiles, hasFixtureFiles, hasDetailFiles
    ]
  );

  // ─── Data loading ───────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId) {
      navigate("/");
      return;
    }

    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        const [fileResponse, featureResponse, wizardResponse] = await Promise.all([
          fetchSessionFiles(sessionId),
          fetchSessionFeatures(sessionId),
          fetchWizardState(sessionId)
        ]);
        if (!active) return;
        setSessionExpiredMessage(null);
        setFiles(fileResponse.files);
        setWizardState(wizardResponse.wizard);
        setFeatures(
          (featureResponse.features as Array<Record<string, unknown>>).map((item) => ({
            type: String(item.type || "Feature"),
            feature_type: typeof item.feature_type === "string" ? item.feature_type : undefined,
            geometry:
              item.geometry && typeof item.geometry === "object"
                ? (item.geometry as { type: string; coordinates: unknown })
                : null,
            properties:
              item.properties && typeof item.properties === "object"
                ? (item.properties as { source_file?: string; [key: string]: unknown })
                : {}
          }))
        );
      } catch (error) {
        const message = handleApiError(error, t("Failed to load wizard state", "ウィザード情報の読み込みに失敗しました"), {
          title: t("Failed to load wizard", "ウィザード読み込み失敗")
        });
        setWizardSaveStatus("error", message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [handleApiError, navigate, sessionId, setFiles, setSessionExpiredMessage, setWizardSaveStatus, setWizardState]);

  // ─── API actions ────────────────────────────────────────────────────

  const refreshFeatures = async () => {
    if (!sessionId) return;
    const featureResponse = await fetchSessionFeatures(sessionId);
    setFeatures(
      (featureResponse.features as Array<Record<string, unknown>>).map((item) => ({
        type: String(item.type || "Feature"),
        feature_type: typeof item.feature_type === "string" ? item.feature_type : undefined,
        geometry:
          item.geometry && typeof item.geometry === "object"
            ? (item.geometry as { type: string; coordinates: unknown })
            : null,
        properties:
          item.properties && typeof item.properties === "object"
            ? (item.properties as { source_file?: string; [key: string]: unknown })
            : {}
      }))
    );
  };

  const refreshWizard = async () => {
    if (!sessionId) return;
    const response = await fetchWizardState(sessionId);
    setWizardState(response.wizard);
  };

  // Every wizard PATCH answers with the whole wizard state, which replaces the
  // store's copy. Two in flight at once can land out of order, and the older
  // answer then undoes the newer save. Leaving a section sends its save and the
  // level sync together, so this is the ordinary case, not a corner. A read
  // that follows a write (the refresh after a mappings upload) joins the queue
  // with it, or an older PATCH answer can land after the fresher read.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = writeQueue.current.then(task, task);
    writeQueue.current = run.catch(() => undefined);
    return run;
  };

  const pushLevels = async () => {
    if (!sessionId) return;
    const response = await patchWizardLevels(sessionId, toLevelItemsFromFiles(files));
    setWizardState(response.wizard);
  };
  const syncLevels = () => serialize(pushLevels);

  const runDetectAll = () =>
    persist(
      async () => {
        if (!sessionId) return;
        const response = await detectAllFiles(sessionId);
        setFiles(response.files);
        await refreshFeatures();
        setLearningSuggestion(null);
        pushToast({
          title: t("Detection complete", "検出完了"),
          description: t("File types were refreshed.", "ファイル種別を更新しました。"),
          variant: "success"
        });
      },
      t("Detect all failed", "一括検出に失敗しました"),
      t("Detection failed", "検出失敗")
    );

  // Once the server holds what a draft says, the draft goes, so whatever the
  // server has next is what the form shows. A draft edited again while its
  // save was in flight no longer matches, and stays for the trailing save.
  const releaseDraft = <K extends keyof WizardDrafts>(section: K, saved: WizardDrafts[K]) => {
    const draft = useAppStore.getState().wizardDrafts[section];
    if (draft !== null && sameAsSaved(draft, saved)) setWizardDraft(section, null);
  };

  // Every save reports through the footer. A failure keeps its own retry, so
  // the operator can resend exactly what failed without re-editing anything.
  // An autosave passes its own `retry`, which resends through the autosave
  // so the hook knows the failed edit was stored; re-running the task alone
  // would leave the hook counting it as unsaved.
  const persist = (
    task: () => Promise<void>,
    fallback: string,
    title: string,
    retry?: () => void
  ): Promise<boolean> => {
    const attempt = async (): Promise<boolean> => {
      try {
        setWizardSaveStatus("saving");
        await serialize(task);
        setWizardSaveStatus("saved");
        return true;
      } catch (error) {
        const message = handleApiError(error, fallback, { title });
        setWizardSaveStatus("error", message, retry ?? (() => void attempt()));
        return false;
      }
    };
    return attempt();
  };

  // True only while the beforeunload handler flushes, so just that last save
  // asks the browser to outlive the page. keepalive requests share a small
  // in-flight budget, which ordinary autosaves have no reason to spend.
  const unloading = useRef(false);

  const patchFile = (stem: string, payload: UpdateFileRequest) =>
    persist(
      async () => {
        if (!sessionId) return;
        const response = await updateSessionFile(sessionId, stem, payload);
        setFiles(response.files);
        if (response.learning_suggestion) {
          setLearningSuggestion(response.learning_suggestion);
        } else if (payload.apply_learning) {
          setLearningSuggestion(null);
        }
        await refreshFeatures();
      },
      t("Failed to save file mapping", "ファイル分類の保存に失敗しました"),
      t("Failed to save classification", "分類保存失敗")
    );

  const saveProject = (payload: ProjectWizardState, retry: () => void) => {
    const keepalive = unloading.current;
    return persist(
      async () => {
        if (!sessionId) return;
        const response = await patchWizardProject(sessionId, payload, { keepalive });
        setWizardState(response.wizard);
        releaseDraft("project", response.wizard.project);
      },
      t("Failed to save project info", "プロジェクト情報の保存に失敗しました"),
      t("Failed to save project", "保存失敗"),
      retry
    );
  };

  const searchProjectAddress = async (query: string, language: string): Promise<GeocodeResultItem[]> => {
    if (!sessionId) return [];
    try {
      const response = await searchWizardAddress(sessionId, query, language);
      return response.results;
    } catch (error) {
      handleApiError(error, t("Address search failed", "住所検索に失敗しました"), {
        title: t("Search failed", "検索失敗")
      });
      return [];
    }
  };

  const autofillProjectAddressFromGeometry = async (language: string): Promise<GeocodeResultItem | null> => {
    if (!sessionId) return null;
    try {
      const response = await autofillWizardAddressFromGeometry(sessionId, language);
      if (response.warnings.length > 0) {
        pushToast({
          title: t("Autofill notice", "自動入力の通知"),
          description: response.warnings[0],
          variant: "info"
        });
      }
      return response.result;
    } catch (error) {
      handleApiError(error, t("Location-based autofill failed", "位置ベースの自動入力に失敗しました"), {
        title: t("Autofill failed", "自動入力失敗")
      });
      return null;
    }
  };

  const saveBuildings = (payload: BuildingWizardState[], retry: () => void) => {
    const keepalive = unloading.current;
    return persist(
      async () => {
        if (!sessionId) return;
        const response = await patchWizardBuildings(sessionId, payload, { keepalive });
        setWizardState(response.wizard);
        releaseDraft("buildings", response.wizard.buildings);
      },
      t("Failed to save building assignments", "建物割り当ての保存に失敗しました"),
      t("Failed to save buildings", "建物保存失敗"),
      retry
    );
  };

  const saveMappings = (payload: {
    unit?: UnitMappingState;
    opening?: OpeningMappingState;
    fixture?: FixtureMappingState;
    detail_confirmed?: boolean;
    unit_category_overrides?: Record<string, string>;
  }) =>
    persist(
      async () => {
        if (!sessionId) return;
        const response = await patchWizardMappings(sessionId, payload);
        setWizardState(response.wizard);
      },
      t("Failed to save mappings", "マッピングの保存に失敗しました"),
      t("Failed to save mappings", "保存失敗")
    );

  const saveFootprint = (payload: FootprintWizardState, retry: () => void) => {
    const keepalive = unloading.current;
    return persist(
      async () => {
        if (!sessionId) return;
        const response = await patchWizardFootprint(sessionId, payload, { keepalive });
        setWizardState(response.wizard);
        releaseDraft("footprint", response.wizard.footprint);
      },
      t("Failed to save footprint options", "Footprint 設定の保存に失敗しました"),
      t("Failed to save footprint", "Footprint 保存失敗"),
      retry
    );
  };

  const projectAutosave = useAutosave(
    projectDraft,
    (value) => saveProject(normalizeProjectForSave(value), () => projectAutosave.flush()),
    { canSave: !projectHeld }
  );
  const buildingsAutosave = useAutosave(
    buildingsDraft,
    (value) => saveBuildings(normalizeBuildingsForSave(value), () => buildingsAutosave.flush()),
    { canSave: !buildingsHeld }
  );
  const footprintAutosave = useAutosave(
    footprintDraft,
    (value) => saveFootprint(value, () => footprintAutosave.flush()),
    { canSave: true }
  );

  const autosaves = [projectAutosave, buildingsAutosave, footprintAutosave];
  const flushDrafts = () => autosaves.forEach((autosave) => autosave.flush());

  const selectSection = (id: string) => {
    flushDrafts();
    setActiveSection(id);
  };

  // Closing or reloading the tab ends the session's in-memory drafts and can
  // cut off a save still being sent, so the browser is asked to confirm while
  // anything is unsaved. Flushing first gives a debounced edit the length of
  // that prompt to reach the server.
  const unloadGuard = useRef<() => boolean>(() => false);
  unloadGuard.current = () => {
    unloading.current = true;
    try {
      flushDrafts();
    } finally {
      unloading.current = false;
    }
    return projectHeld || buildingsHeld || autosaves.some((autosave) => autosave.unsaved());
  };
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unloadGuard.current()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const applyLearningSuggestion = async () => {
    if (!sessionId || !learningSuggestion) return;
    const targetStem = learningSuggestion.source_stem;
    if (!targetStem) {
      setLearningSuggestion(null);
      return;
    }
    await patchFile(targetStem, {
      detected_type: learningSuggestion.feature_type,
      apply_learning: true,
      learning_keyword: learningSuggestion.keyword
    });
    setLearningSuggestion(null);
  };

  const uploadMappingsFile = (file: File) =>
    persist(
      async () => {
        if (!sessionId) return;
        await uploadCompanyMappings(sessionId, file);
        await refreshWizard();
        pushToast({
          title: t("Mappings uploaded", "マッピングをアップロードしました"),
          description: t("Company mappings were applied.", "会社コード対応を適用しました。"),
          variant: "success"
        });
      },
      t("Failed to upload company mappings", "会社コード対応のアップロードに失敗しました"),
      t("Upload failed", "アップロード失敗")
    );

  const confirmSummary = async () => {
    if (!sessionId || !canGenerate) return;
    // Generation reads the server's copy, so every edit has to be there first.
    // A save that fails again leaves its error and Retry in the footer.
    const stored = await Promise.all(autosaves.map((autosave) => autosave.settle()));
    if (stored.includes(false)) return;
    try {
      setWizardSaveStatus("saving");
      await serialize(async () => {
        await pushLevels();
        await generateSessionDraft(sessionId);
        await refreshFeatures();
      });
      setCurrentScreen("review");
      setWizardSaveStatus("saved");
      pushToast({
        title: t("Draft generated", "ドラフト生成完了"),
        description: t("Opening review workspace.", "レビュー画面を開きます。"),
        variant: "success"
      });
      navigate(projectPath(sessionId, "check"));
    } catch (error) {
      const message = handleApiError(error, t("Failed to generate draft features", "ドラフト生成に失敗しました"), {
        title: t("Generation failed", "生成失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  // ─── Section rendering ──────────────────────────────────────────────

  const helpText = SECTION_HELP[activeSection] ?? SECTION_HELP["project"];

  // The heading names the section the rail is on, so the two never disagree.
  const activeSectionLabel = useMemo(() => {
    for (const section of sections) {
      if (section.id === activeSection) return t(section.labelEn, section.labelJa);
      const child = section.children?.find((item) => item.id === activeSection);
      if (child) return t(child.labelEn, child.labelJa);
    }
    return t("Configure", "設定");
  }, [sections, activeSection, t]);

  const showSection = () => {
    switch (activeSection) {
      case "project":
      case "project-info":
        return (
          <ProjectInfoStep
            project={project}
            onChange={(next) => setWizardDraft("project", next)}
            onSearchAddress={(query, language) => searchProjectAddress(query, language)}
            onAutofillFromGeometry={(language) => autofillProjectAddressFromGeometry(language)}
          />
        );

      case "building":
        return (
          <BuildingStep
            buildings={buildings}
            allFileStems={allFileStems}
            venueName={project?.venue_name ?? ""}
            venueAddress={project?.address ?? null}
            onChange={(next) => setWizardDraft("buildings", next)}
          />
        );

      case "footprint":
        return (
          <FootprintStep
            footprint={footprint}
            onChange={(next) => setWizardDraft("footprint", next)}
          />
        );

      case "files":
        return (
          <FileClassStep
            files={files}
            features={features}
            selectedStem={selectedFileStem}
            hoveredStem={hoveredFileStem}
            loading={wizardSaveStatus === "saving"}
            onDetectAll={() => void runDetectAll()}
            onChangeType={(stem, nextType) =>
              void patchFile(stem, { detected_type: nextType || null })
            }
            onSelectStem={setSelectedFileStem}
            onHoverStem={setHoveredFileStem}
          />
        );

      case "levels":
        return (
          <LevelMapStep
            files={files}
            onPatchFile={(stem, payload) => void patchFile(stem, payload)}
          />
        );

      case "attributes":
      case "unit":
        return (
          <UnitMapStep
            files={files}
            mapping={wizardState?.mappings.unit ?? EMPTY_UNIT_MAPPING}
            saving={wizardSaveStatus === "saving"}
            onSave={(mapping) => void saveMappings({ unit: mapping })}
            onAssignCategory={(rawCode, category) =>
              void saveMappings({ unit_category_overrides: { [rawCode]: category } })
            }
            onUploadCompanyMappings={(file) => void uploadMappingsFile(file)}
          />
        );

      case "opening":
        return (
          <OpeningMapStep
            files={files}
            mapping={wizardState?.mappings.opening ?? EMPTY_OPENING_MAPPING}
            onSave={(mapping) => void saveMappings({ opening: mapping })}
          />
        );

      case "fixture":
        return (
          <FixtureMapStep
            files={files}
            mapping={wizardState?.mappings.fixture ?? EMPTY_FIXTURE_MAPPING}
            onSave={(mapping) => void saveMappings({ fixture: mapping })}
          />
        );

      case "detail":
        return (
          <DetailMapStep files={files} />
        );

      case "summary":
        return (
          <SummaryStep
            files={files}
            cleanupSummary={cleanupSummary}
            wizard={wizardState}
            disabled={!canGenerate}
            onConfirm={() => void confirmSummary()}
          />
        );

      default:
        return null;
    }
  };

  // ─── Keyboard shortcuts ─────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || isFormTarget(event.target)) return;
      if (loading || wizardSaveStatus === "saving") return;
      if (activeSection === "summary") {
        event.preventDefault();
        void confirmSummary();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loading, activeSection, wizardSaveStatus, confirmSummary]);

  // Sync levels when leaving the levels section
  useEffect(() => {
    if (activeSection !== "levels") {
      void syncLevels();
    }
  }, [activeSection]);

  const inShell = useInShell();
  const footerButtonRef = useRef<HTMLDivElement>(null);
  const incompleteSections = sections.filter((section) => section.id !== "summary" && !section.valid).length;
  usePrimaryAction(
    footerAction
      ? {
          label: footerAction.label,
          run: () => footerAction.run(),
          disabledReason: footerAction.enabled ? null : (footerAction.blockedReason ?? null),
          busy: wizardSaveStatus === "saving",
          blockers: footerAction.enabled ? null : incompleteSections,
          anchor: footerButtonRef
        }
      : null
  );
  usePageShell({ saveHeld: projectHeld || buildingsHeld });

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <main className="mx-auto flex w-full max-w-[1850px] flex-col gap-5 px-4 py-5 md:px-6 xl:px-8">
      <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
        <SectionNav
          sections={sections}
          activeSection={activeSection}
          onSelect={selectSection}
        />

        <div className="flex flex-col gap-4">
          {/* Section help was a bordered, icon-led box of its own; it is one
              sentence about the heading right above it, so it reads as one. */}
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold leading-7 tracking-tight text-foreground">
              {activeSectionLabel}
            </h1>
            <p className="text-[13px] leading-[18px] text-muted-foreground">
              {isJapanese ? helpText.ja : helpText.en}
            </p>
          </div>

          {/* Section content */}
          <WizardFooterProvider onAction={setFooterAction}>
            {loading ? <WizardStepSkeleton /> : showSection()}
          </WizardFooterProvider>

          {/* Learning suggestion banner */}
          {learningSuggestion ? (
            <div className="rounded-lg border border-warning/30 bg-warning-surface p-3 text-[13px] leading-[18px] text-warning-foreground">
              <p>{learningSuggestion.message}</p>
              <div className="mt-2 flex gap-2">
                <Button variant="default" size="sm" onClick={() => void applyLearningSuggestion()}>
                  {t("Apply Learning", "学習ルールを適用")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setLearningSuggestion(null)}>
                  {t("Dismiss", "閉じる")}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Every section saves as you edit, so the footer reports rather than
              asks. The one button it can carry is Summary's Generate. */}
          <div className="sticky bottom-0 z-10 -mb-5 flex items-center justify-between gap-3 border-t border-border bg-background py-3">
            <span
              className="flex items-center gap-2 text-xs leading-4 text-muted-foreground"
              role={wizardSaveStatus === "error" ? "alert" : undefined}
            >
              {wizardSaveStatus === "saving" ? (
                t("Saving…", "保存中…")
              ) : wizardSaveStatus === "error" ? (
                <>
                  <span className="text-destructive">
                    {t("Could not save", "保存できませんでした")}
                    {wizardSaveError ? ` — ${wizardSaveError}` : ""}
                  </span>
                  {wizardSaveRetry ? (
                    <Button variant="outline" size="sm" onClick={() => wizardSaveRetry()}>
                      {t("Retry", "再試行")}
                    </Button>
                  ) : null}
                </>
              ) : projectHeld ? (
                t(
                  "Venue info not saved yet: venue name, category, locality and country are required to save.",
                  "会場情報は未保存です。保存には会場名・カテゴリ・市区町村・国が必要です。"
                )
              ) : buildingsHeld ? (
                t(
                  "Buildings not saved yet: each assigned file must be a known file, assigned once, to save.",
                  "建物は未保存です。保存するには、割り当てファイルを既存のファイル名で重複なく指定してください。"
                )
              ) : wizardSaveStatus === "saved" && wizardSavedAt !== null && !inShell ? (
                <>
                  {t("Saved", "保存済み")} · <span className="font-mono">{formatClock(wizardSavedAt)}</span>
                </>
              ) : footerAction ? null : (
                t("Changes are saved as you edit.", "編集内容は自動的に保存されます。")
              )}
            </span>

            {footerAction ? (
              <div ref={footerButtonRef}>
                <DisabledHint
                  className="w-auto"
                  hint={footerAction.enabled ? null : (footerAction.blockedReason ?? null)}
                >
                  <Button
                    disabled={!footerAction.enabled || wizardSaveStatus === "saving"}
                    onClick={() => footerAction.run()}
                  >
                    {footerAction.label}
                  </Button>
                </DisabledHint>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
