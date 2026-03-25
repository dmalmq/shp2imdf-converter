import { useEffect, useMemo, useState } from "react";
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
import { BuildingStep } from "../components/wizard/BuildingStep";
import { DetailMapStep } from "../components/wizard/DetailMapStep";
import { FileClassStep } from "../components/wizard/FileClassStep";
import { FixtureMapStep } from "../components/wizard/FixtureMapStep";
import { FootprintStep } from "../components/wizard/FootprintStep";
import { LevelMapStep } from "../components/wizard/LevelMapStep";
import { OpeningMapStep } from "../components/wizard/OpeningMapStep";
import { ProjectInfoStep } from "../components/wizard/ProjectInfoStep";
import { SectionNav, type SectionDef } from "../components/wizard/SectionNav";
import { SummaryStep } from "../components/wizard/SummaryStep";
import { UnitMapStep } from "../components/wizard/UnitMapStep";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";
import { Button, Badge } from "../components/ui";

const LEVEL_REQUIRED_TYPES = new Set(["unit", "opening", "fixture", "detail", "kiosk", "section"]);

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
  footprint_buffer_m: 0.5,
  venue_buffer_m: 5
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

function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function WizardStepSkeleton() {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
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
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);
  const files = useAppStore((state) => state.files);
  const cleanupSummary = useAppStore((state) => state.cleanupSummary);
  const wizardState = useAppStore((state) => state.wizardState);
  const setFiles = useAppStore((state) => state.setFiles);
  const setWizardState = useAppStore((state) => state.setWizardState);
  const selectedFileStem = useAppStore((state) => state.selectedFileStem);
  const setSelectedFileStem = useAppStore((state) => state.setSelectedFileStem);
  const hoveredFileStem = useAppStore((state) => state.hoveredFileStem);
  const setHoveredFileStem = useAppStore((state) => state.setHoveredFileStem);
  const wizardSaveStatus = useAppStore((state) => state.wizardSaveStatus);
  const wizardSaveError = useAppStore((state) => state.wizardSaveError);
  const setWizardSaveStatus = useAppStore((state) => state.setWizardSaveStatus);
  const learningSuggestion = useAppStore((state) => state.learningSuggestion);
  const setLearningSuggestion = useAppStore((state) => state.setLearningSuggestion);
  const setSessionExpiredMessage = useAppStore((state) => state.setSessionExpiredMessage);
  const handleApiError = useApiErrorHandler();
  const pushToast = useToast();
  const { t, isJapanese } = useUiLanguage();

  const [activeSection, setActiveSection] = useState("project");
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

  // ─── Validation ─────────────────────────────────────────────────────

  const projectComplete = useMemo(() => {
    const project = wizardState?.project;
    if (!project) return false;
    return Boolean(
      project.venue_name.trim() &&
      project.venue_category.trim() &&
      project.address.locality.trim() &&
      project.address.country.trim()
    );
  }, [wizardState]);

  const allClassified = useMemo(() => files.every((f) => Boolean(f.detected_type)), [files]);

  const levelsComplete = useMemo(() => {
    const required = files.filter((f) => LEVEL_REQUIRED_TYPES.has(f.detected_type ?? ""));
    return required.length === 0 || required.every((f) => f.detected_level !== null);
  }, [files]);

  const buildingsComplete = useMemo(() => {
    const required = files.filter((f) => LEVEL_REQUIRED_TYPES.has(f.detected_type ?? ""));
    if (required.length === 0) return true;
    const buildings = wizardState?.buildings ?? [];
    if (buildings.length === 0) return false;
    const assigned = new Set(buildings.flatMap((b) => b.file_stems));
    const allAssigned = required.every((f) => assigned.has(f.stem));
    const addressesValid = buildings.every((b) => {
      if (b.address_mode !== "different_address") return true;
      return Boolean(b.address?.locality?.trim() && b.address?.country?.trim());
    });
    return allAssigned && addressesValid;
  }, [files, wizardState]);

  const unitMappingComplete = useMemo(
    () => !hasUnitFiles || Boolean(wizardState?.mappings.unit.code_column),
    [hasUnitFiles, wizardState]
  );

  const detailConfirmed = useMemo(
    () => !hasDetailFiles || Boolean(wizardState?.mappings.detail_confirmed),
    [hasDetailFiles, wizardState]
  );

  const projectSectionValid = projectComplete && buildingsComplete;
  const attributeSectionValid = unitMappingComplete && detailConfirmed;

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
          { id: "detail", labelEn: "Detail Mapping", labelJa: "Detail 設定", valid: detailConfirmed, hidden: !hasDetailFiles }
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
      levelsComplete, attributeSectionValid, unitMappingComplete, detailConfirmed,
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

  const syncLevels = async () => {
    if (!sessionId) return;
    const response = await patchWizardLevels(sessionId, toLevelItemsFromFiles(files));
    setWizardState(response.wizard);
  };

  const runDetectAll = async () => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      const response = await detectAllFiles(sessionId);
      setFiles(response.files);
      await refreshFeatures();
      setLearningSuggestion(null);
      setWizardSaveStatus("saved");
      pushToast({
        title: t("Detection complete", "検出完了"),
        description: t("File types were refreshed.", "ファイル種別を更新しました。"),
        variant: "success"
      });
    } catch (error) {
      const message = handleApiError(error, t("Detect all failed", "一括検出に失敗しました"), {
        title: t("Detection failed", "検出失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  const patchFile = async (stem: string, payload: UpdateFileRequest) => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      const response = await updateSessionFile(sessionId, stem, payload);
      setFiles(response.files);
      if (response.learning_suggestion) {
        setLearningSuggestion(response.learning_suggestion);
      } else if (payload.apply_learning) {
        setLearningSuggestion(null);
      }
      await refreshFeatures();
      setWizardSaveStatus("saved");
    } catch (error) {
      const message = handleApiError(error, t("Failed to save file mapping", "ファイル分類の保存に失敗しました"), {
        title: t("Failed to save classification", "分類保存失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  const saveProject = async (payload: ProjectWizardState) => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      const response = await patchWizardProject(sessionId, payload);
      setWizardState(response.wizard);
      setWizardSaveStatus("saved");
    } catch (error) {
      const message = handleApiError(error, t("Failed to save project info", "プロジェクト情報の保存に失敗しました"), {
        title: t("Failed to save project", "保存失敗")
      });
      setWizardSaveStatus("error", message);
    }
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

  const saveBuildings = async (buildings: BuildingWizardState[]) => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      const response = await patchWizardBuildings(sessionId, buildings);
      setWizardState(response.wizard);
      setWizardSaveStatus("saved");
    } catch (error) {
      const message = handleApiError(error, t("Failed to save building assignments", "建物割り当ての保存に失敗しました"), {
        title: t("Failed to save buildings", "建物保存失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  const saveMappings = async (payload: {
    unit?: UnitMappingState;
    opening?: OpeningMappingState;
    fixture?: FixtureMappingState;
    detail_confirmed?: boolean;
    unit_category_overrides?: Record<string, string>;
  }) => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      const response = await patchWizardMappings(sessionId, payload);
      setWizardState(response.wizard);
      setWizardSaveStatus("saved");
    } catch (error) {
      const message = handleApiError(error, t("Failed to save mappings", "マッピングの保存に失敗しました"), {
        title: t("Failed to save mappings", "保存失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  const saveFootprint = async (payload: FootprintWizardState) => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      const response = await patchWizardFootprint(sessionId, payload);
      setWizardState(response.wizard);
      setWizardSaveStatus("saved");
    } catch (error) {
      const message = handleApiError(error, t("Failed to save footprint options", "Footprint 設定の保存に失敗しました"), {
        title: t("Failed to save footprint", "Footprint 保存失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

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

  const uploadMappingsFile = async (file: File) => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      await uploadCompanyMappings(sessionId, file);
      await refreshWizard();
      setWizardSaveStatus("saved");
      pushToast({
        title: t("Mappings uploaded", "マッピングをアップロードしました"),
        description: t("Company mappings were applied.", "会社コード対応を適用しました。"),
        variant: "success"
      });
    } catch (error) {
      const message = handleApiError(error, t("Failed to upload company mappings", "会社コード対応のアップロードに失敗しました"), {
        title: t("Upload failed", "アップロード失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  const confirmSummary = async () => {
    if (!sessionId) return;
    try {
      setWizardSaveStatus("saving");
      await syncLevels();
      await generateSessionDraft(sessionId);
      await refreshFeatures();
      setCurrentScreen("review");
      setWizardSaveStatus("saved");
      pushToast({
        title: t("Draft generated", "ドラフト生成完了"),
        description: t("Opening review workspace.", "レビュー画面を開きます。"),
        variant: "success"
      });
      navigate("/review");
    } catch (error) {
      const message = handleApiError(error, t("Failed to generate draft features", "ドラフト生成に失敗しました"), {
        title: t("Generation failed", "生成失敗")
      });
      setWizardSaveStatus("error", message);
    }
  };

  // ─── Section rendering ──────────────────────────────────────────────

  const helpText = SECTION_HELP[activeSection] ?? SECTION_HELP["project"];

  const showSection = () => {
    switch (activeSection) {
      case "project":
      case "project-info":
        return (
          <ProjectInfoStep
            project={wizardState?.project ?? null}
            saving={wizardSaveStatus === "saving"}
            onSave={(payload) => void saveProject(payload)}
            onSearchAddress={(query, language) => searchProjectAddress(query, language)}
            onAutofillFromGeometry={(language) => autofillProjectAddressFromGeometry(language)}
          />
        );

      case "building":
        return (
          <BuildingStep
            buildings={wizardState?.buildings ?? []}
            allFileStems={files.map((f) => f.stem)}
            venueAddress={wizardState?.project?.address ?? null}
            saving={wizardSaveStatus === "saving"}
            onSave={(buildings) => void saveBuildings(buildings)}
          />
        );

      case "footprint":
        return (
          <FootprintStep
            footprint={wizardState?.footprint ?? EMPTY_FOOTPRINT}
            saving={wizardSaveStatus === "saving"}
            onSave={(payload) => void saveFootprint(payload)}
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
            saving={wizardSaveStatus === "saving"}
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
            saving={wizardSaveStatus === "saving"}
            onSave={(mapping) => void saveMappings({ opening: mapping })}
          />
        );

      case "fixture":
        return (
          <FixtureMapStep
            files={files}
            mapping={wizardState?.mappings.fixture ?? EMPTY_FIXTURE_MAPPING}
            saving={wizardSaveStatus === "saving"}
            onSave={(mapping) => void saveMappings({ fixture: mapping })}
          />
        );

      case "detail":
        return (
          <DetailMapStep
            files={files}
            detailConfirmed={wizardState?.mappings.detail_confirmed ?? false}
            saving={wizardSaveStatus === "saving"}
            onSave={(confirmed) => void saveMappings({ detail_confirmed: confirmed })}
          />
        );

      case "summary":
        return (
          <SummaryStep
            files={files}
            cleanupSummary={cleanupSummary}
            wizard={wizardState}
            saving={wizardSaveStatus === "saving"}
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

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <main className="mx-auto flex w-full max-w-[1850px] flex-col gap-5 px-4 py-5 md:px-6 xl:px-8">
      <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
        <SectionNav
          sections={sections}
          activeSection={activeSection}
          onSelect={setActiveSection}
        />

        <div className="space-y-4">
          {/* Section help */}
          <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-primary)]">
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 7v4M8 5h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {isJapanese ? helpText.ja : helpText.en}
            </p>
          </div>

          {/* Save status */}
          {wizardSaveStatus !== "idle" ? (
            <div className="flex items-center gap-2 text-xs">
              {wizardSaveStatus === "saving" ? (
                <Badge variant="primary">{t("Saving...", "保存中...")}</Badge>
              ) : wizardSaveStatus === "saved" ? (
                <Badge variant="success">{t("Saved", "保存済み")}</Badge>
              ) : wizardSaveStatus === "error" ? (
                <Badge variant="error">
                  {t("Error", "エラー")}: {wizardSaveError ?? t("Unknown", "不明")}
                </Badge>
              ) : null}
            </div>
          ) : null}

          {/* Section content */}
          {loading ? <WizardStepSkeleton /> : showSection()}

          {/* Learning suggestion banner */}
          {learningSuggestion ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-warning)]/30 bg-[var(--color-warning-muted)] p-3 text-sm text-[var(--color-warning)]">
              <p>{learningSuggestion.message}</p>
              <div className="mt-2 flex gap-2">
                <Button variant="primary" size="sm" onClick={() => void applyLearningSuggestion()}>
                  {t("Apply Learning", "学習ルールを適用")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setLearningSuggestion(null)}>
                  {t("Dismiss", "閉じる")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
