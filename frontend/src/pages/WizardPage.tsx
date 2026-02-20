import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

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
import { StepSidebar } from "../components/wizard/StepSidebar";
import { SummaryStep } from "../components/wizard/SummaryStep";
import { UnitMapStep } from "../components/wizard/UnitMapStep";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";

const STEP_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LEVEL_REQUIRED_TYPES = new Set(["unit", "opening", "fixture", "detail"]);

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

type StepValidation = {
  valid: boolean;
  reason: string | null;
};

const STEP_HELP_TEXT: Record<number, { en: string; ja: string }> = {
  1: {
    en: "Set venue basics like name, category, and address. These become your IMDF venue and address records.",
    ja: "会場名・カテゴリ・住所などの基本情報を設定します。ここでの入力が IMDF の venue/address に使われます。"
  },
  2: {
    en: "Confirm each source file type (unit/opening/fixture/detail). Correct classification keeps later mapping accurate.",
    ja: "各ファイルの種別（unit/opening/fixture/detail）を確認します。ここが正しいと後続の変換が安定します。"
  },
  3: {
    en: "Set floor levels and names so every feature is assigned to the correct level in IMDF.",
    ja: "各ファイルの階層（レベル）と名称を設定します。すべての要素が正しい level に紐づきます。"
  },
  4: {
    en: "Group level files into buildings and optionally define building-specific addresses.",
    ja: "レベルファイルを建物ごとに割り当てます。必要に応じて建物別住所も設定できます。"
  },
  5: {
    en: "Choose how unit attributes map to IMDF categories and names. Upload company mappings if needed.",
    ja: "ユニット属性を IMDF カテゴリや名称へ対応付けます。必要なら会社コード対応表をアップロードします。"
  },
  6: {
    en: "Map opening attributes such as category, door type, and accessibility-related fields.",
    ja: "opening のカテゴリ、ドア種別、アクセシビリティ項目などの対応付けを行います。"
  },
  7: {
    en: "Map fixture names and categories for non-unit physical objects.",
    ja: "fixture（設備）の名称とカテゴリを対応付けます。"
  },
  8: {
    en: "Detail features are exported as lightweight line features linked to levels only.",
    ja: "detail は level のみを持つ軽量な線要素として出力されます。"
  },
  9: {
    en: "Pick how footprint and venue outlines are derived from your source geometry.",
    ja: "元データから footprint / venue 外形を作る方法を選択します。"
  },
  10: {
    en: "Review configuration summary, then generate draft IMDF features and continue to review.",
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
    <section className="rounded border bg-white p-5">
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

  const [step, setStep] = useState(1);
  const [helpOpen, setHelpOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [features, setFeatures] = useState<
    {
      type: string;
      feature_type?: string;
      geometry?: { type: string; coordinates: unknown } | null;
      properties?: { source_file?: string; [key: string]: unknown };
    }[]
  >([]);

  const openingCount = useMemo(() => files.filter((item) => item.detected_type === "opening").length, [files]);
  const fixtureCount = useMemo(() => files.filter((item) => item.detected_type === "fixture").length, [files]);
  const detailCount = useMemo(() => files.filter((item) => item.detected_type === "detail").length, [files]);
  const stepHelp = STEP_HELP_TEXT[step] ?? STEP_HELP_TEXT[1];

  const projectComplete = useMemo(() => {
    const project = wizardState?.project;
    if (!project) {
      return false;
    }
    return Boolean(
      project.venue_name.trim() &&
        project.venue_category.trim() &&
        project.address.locality.trim() &&
        project.address.country.trim()
    );
  }, [wizardState]);

  const stepValidation = useMemo<Record<number, StepValidation>>(() => {
    const requiredLevelFiles = files.filter((item) => LEVEL_REQUIRED_TYPES.has(item.detected_type ?? ""));
    const hasRequiredLevelFiles = requiredLevelFiles.length > 0;
    const allClassified = files.every((item) => Boolean(item.detected_type));
    const levelsComplete = !hasRequiredLevelFiles || requiredLevelFiles.every((item) => item.detected_level !== null);

    const buildings = wizardState?.buildings ?? [];
    const hasBuildingRows = buildings.length > 0;
    const assignedStems = new Set(buildings.flatMap((item) => item.file_stems));
    const allRequiredStemsAssigned = !hasRequiredLevelFiles || requiredLevelFiles.every((item) => assignedStems.has(item.stem));
    const buildingAddressesValid = buildings.every((building) => {
      if (building.address_mode !== "different_address") {
        return true;
      }
      return Boolean(building.address?.locality?.trim() && building.address?.country?.trim());
    });
    const buildingsComplete = !hasRequiredLevelFiles || (hasBuildingRows && allRequiredStemsAssigned && buildingAddressesValid);

    const hasUnitFiles = files.some((item) => item.detected_type === "unit");
    const unitMappingComplete = !hasUnitFiles || Boolean(wizardState?.mappings.unit.code_column);

    const hasDetailFiles = files.some((item) => item.detected_type === "detail");
    const detailConfirmed = !hasDetailFiles || Boolean(wizardState?.mappings.detail_confirmed);

    return {
      1: {
        valid: projectComplete,
        reason: projectComplete
          ? null
          : t("Complete required Project Info fields before continuing.", "必須のプロジェクト情報を入力してから進んでください。")
      },
      2: {
        valid: allClassified,
        reason: allClassified
          ? null
          : t("Assign an IMDF type for every imported file.", "取り込んだすべてのファイルに IMDF 種別を設定してください。")
      },
      3: {
        valid: levelsComplete,
        reason: levelsComplete
          ? null
          : t(
              "Set a detected level for each unit, opening, fixture, and detail file.",
              "unit/opening/fixture/detail の各ファイルにレベルを設定してください。"
            )
      },
      4: {
        valid: buildingsComplete,
        reason: buildingsComplete
          ? null
          : t(
              "Save at least one building and ensure each mapped source file is assigned to a building.",
              "少なくとも1つの建物を保存し、対象ファイルを建物へ割り当ててください。"
            )
      },
      5: {
        valid: unitMappingComplete,
        reason: unitMappingComplete ? null : t("Select a Unit code column before continuing.", "Unit のコード列を選択してから進んでください。")
      },
      6: { valid: true, reason: null },
      7: { valid: true, reason: null },
      8: {
        valid: detailConfirmed,
        reason: detailConfirmed
          ? null
          : t("Confirm detail export settings before continuing.", "detail の出力設定を確認してから進んでください。")
      },
      9: { valid: true, reason: null },
      10: { valid: true, reason: null }
    };
  }, [files, projectComplete, t, wizardState]);

  const steps = useMemo(
    () => [
      { id: 1, label: t("Project Info", "プロジェクト情報") },
      { id: 2, label: t("File Classification", "ファイル分類") },
      { id: 3, label: t("Level Mapping", "レベル対応付け") },
      { id: 4, label: t("Building Assignment", "建物割り当て") },
      { id: 5, label: t("Unit Mapping", "Unit 対応付け") },
      {
        id: 6,
        label: openingCount ? t("Opening Mapping", "Opening 対応付け") : t("Opening Mapping (No files)", "Opening 対応付け（対象なし）")
      },
      {
        id: 7,
        label: fixtureCount ? t("Fixture Mapping", "Fixture 対応付け") : t("Fixture Mapping (No files)", "Fixture 対応付け（対象なし）")
      },
      {
        id: 8,
        label: detailCount ? t("Detail Mapping", "Detail 設定") : t("Detail Mapping (No files)", "Detail 設定（対象なし）")
      },
      { id: 9, label: t("Footprint Options", "Footprint 設定") },
      { id: 10, label: t("Summary", "概要") }
    ],
    [detailCount, fixtureCount, openingCount, t]
  );

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
        if (!active) {
          return;
        }
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
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [handleApiError, navigate, sessionId, setFiles, setSessionExpiredMessage, setWizardSaveStatus, setWizardState]);

  const refreshFeatures = async () => {
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
    const response = await fetchWizardState(sessionId);
    setWizardState(response.wizard);
  };

  const syncLevels = async () => {
    if (!sessionId) {
      return;
    }
    const response = await patchWizardLevels(sessionId, toLevelItemsFromFiles(files));
    setWizardState(response.wizard);
  };

  const runDetectAll = async () => {
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return [];
    }
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
    if (!sessionId) {
      return null;
    }
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
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
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
    if (!sessionId || !learningSuggestion) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
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

  const showStep = () => {
    if (step === 1) {
      return (
        <ProjectInfoStep
          project={wizardState?.project ?? null}
          saving={wizardSaveStatus === "saving"}
          onSave={(payload) => void saveProject(payload)}
          onSearchAddress={(query, language) => searchProjectAddress(query, language)}
          onAutofillFromGeometry={(language) => autofillProjectAddressFromGeometry(language)}
        />
      );
    }

    if (step === 2) {
      return (
        <FileClassStep
          files={files}
          features={features}
          selectedStem={selectedFileStem}
          hoveredStem={hoveredFileStem}
          loading={wizardSaveStatus === "saving"}
          onDetectAll={() => void runDetectAll()}
          onChangeType={(stem, nextType) =>
            void patchFile(stem, {
              detected_type: nextType || null
            })
          }
          onSelectStem={setSelectedFileStem}
          onHoverStem={setHoveredFileStem}
        />
      );
    }

    if (step === 3) {
      return (
        <LevelMapStep
          files={files}
          saving={wizardSaveStatus === "saving"}
          onPatchFile={(stem, payload) => void patchFile(stem, payload)}
        />
      );
    }

    if (step === 4) {
      return (
        <BuildingStep
          buildings={wizardState?.buildings ?? []}
          allFileStems={files.map((item) => item.stem)}
          venueAddress={wizardState?.project?.address ?? null}
          saving={wizardSaveStatus === "saving"}
          onSave={(buildings) => void saveBuildings(buildings)}
        />
      );
    }

    if (step === 5) {
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
    }

    if (step === 6) {
      return (
        <OpeningMapStep
          files={files}
          mapping={wizardState?.mappings.opening ?? EMPTY_OPENING_MAPPING}
          saving={wizardSaveStatus === "saving"}
          onSave={(mapping) => void saveMappings({ opening: mapping })}
        />
      );
    }

    if (step === 7) {
      return (
        <FixtureMapStep
          files={files}
          mapping={wizardState?.mappings.fixture ?? EMPTY_FIXTURE_MAPPING}
          saving={wizardSaveStatus === "saving"}
          onSave={(mapping) => void saveMappings({ fixture: mapping })}
        />
      );
    }

    if (step === 8) {
      return (
        <DetailMapStep
          files={files}
          detailConfirmed={wizardState?.mappings.detail_confirmed ?? false}
          saving={wizardSaveStatus === "saving"}
          onSave={(confirmed) => void saveMappings({ detail_confirmed: confirmed })}
        />
      );
    }

    if (step === 9) {
      return (
        <FootprintStep
          footprint={wizardState?.footprint ?? EMPTY_FOOTPRINT}
          saving={wizardSaveStatus === "saving"}
          onSave={(payload) => void saveFootprint(payload)}
        />
      );
    }

    return (
      <SummaryStep
        files={files}
        cleanupSummary={cleanupSummary}
        wizard={wizardState}
        saving={wizardSaveStatus === "saving"}
        onConfirm={() => void confirmSummary()}
      />
    );
  };

  const nextStep = () => {
    const currentValidation = stepValidation[step];
    if (step < 10 && currentValidation && !currentValidation.valid) {
      pushToast({
        title: t("Step incomplete", "入力が不足しています"),
        description: currentValidation.reason ?? t("Complete required fields before continuing.", "必須項目を入力してから進んでください。"),
        variant: "error"
      });
      return;
    }

    const currentIndex = STEP_ORDER.indexOf(step);
    if (currentIndex === -1 || currentIndex >= STEP_ORDER.length - 1) {
      return;
    }
    if (step === 3) {
      void syncLevels();
    }
    setStep(STEP_ORDER[currentIndex + 1]);
  };

  const prevStep = () => {
    const currentIndex = STEP_ORDER.indexOf(step);
    if (currentIndex <= 0) {
      return;
    }
    setStep(STEP_ORDER[currentIndex - 1]);
  };

  const selectStep = (targetStep: number) => {
    const targetIndex = STEP_ORDER.indexOf(targetStep);
    if (targetIndex <= 0) {
      setStep(targetStep);
      return;
    }

    const blockingStep = STEP_ORDER.slice(0, targetIndex).find((id) => !stepValidation[id]?.valid);
    if (blockingStep) {
      setStep(blockingStep);
      pushToast({
        title: t("Complete earlier steps first", "先の手順に進む前に入力が必要です"),
        description: stepValidation[blockingStep]?.reason ?? t("Complete required fields before continuing.", "必須項目を入力してから進んでください。"),
        variant: "error"
      });
      return;
    }

    setStep(targetStep);
  };

  const skipToSummary = () => {
    const blockingStep = STEP_ORDER.slice(0, 9).find((id) => !stepValidation[id]?.valid);
    if (blockingStep) {
      setStep(blockingStep);
      pushToast({
        title: t("Summary is locked", "概要へ進むには入力が必要です"),
        description: stepValidation[blockingStep]?.reason ?? t("Complete required fields before continuing.", "必須項目を入力してから進んでください。"),
        variant: "error"
      });
      return;
    }
    setStep(10);
    void syncLevels();
  };

  const canGoNext = step < 10 && stepValidation[step]?.valid === true;
  const nextBlockedReason = step < 10 ? stepValidation[step]?.reason : null;

  useEffect(() => {
    setHelpOpen(false);
  }, [step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || isFormTarget(event.target)) {
        return;
      }
      if (loading || wizardSaveStatus === "saving") {
        return;
      }
      event.preventDefault();
      if (step === 10) {
        void confirmSummary();
        return;
      }
      nextStep();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loading, step, wizardSaveStatus, nextStep, confirmSummary]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-6 px-6 py-7 xl:px-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold">{t("Wizard", "ウィザード")}</h1>
          <p className="text-sm text-slate-600">
            {t("Session", "セッション")}: <span className="font-mono">{sessionId ?? t("No active session", "アクティブなセッションなし")}</span>
          </p>
        </div>
        <Link className="rounded bg-slate-700 px-3 py-2 text-sm text-white" to="/">
          {t("Back to Upload", "アップロードへ戻る")}
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <StepSidebar steps={steps} currentStep={step} onSelectStep={selectStep} onSkipToSummary={skipToSummary} />
        <div className="space-y-5">
          <div className="rounded border bg-white px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <p className="font-medium">{t("Step Help", "ステップヘルプ")}</p>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 text-sm font-semibold text-slate-700"
                onClick={() => setHelpOpen((previous) => !previous)}
                aria-label={t("Toggle step help", "ヘルプ表示の切り替え")}
                title={t("Toggle step help", "ヘルプ表示の切り替え")}
              >
                ?
              </button>
            </div>
            {helpOpen ? (
              <p className="mt-2 text-slate-600">{isJapanese ? stepHelp.ja : stepHelp.en}</p>
            ) : (
              <p className="mt-2 text-slate-500">{t("Click ? for a short explanation of this step.", "このステップの説明は ? を押してください。")}</p>
            )}
          </div>

          {loading ? <WizardStepSkeleton /> : showStep()}

          {learningSuggestion && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <p>{learningSuggestion.message}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs text-white"
                  onClick={() => void applyLearningSuggestion()}
                >
                  {t("Apply Learning", "学習ルールを適用")}
                </button>
                <button
                  type="button"
                  className="rounded border border-amber-400 px-3 py-1.5 text-xs"
                  onClick={() => setLearningSuggestion(null)}
                >
                  {t("Dismiss", "閉じる")}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded border bg-white px-5 py-3.5">
            <div className="text-sm">
              {wizardSaveStatus === "saving" && t("Saving...", "保存中...")}
              {wizardSaveStatus === "saved" && t("Saved", "保存済み")}
              {wizardSaveStatus === "error" && (
                <span className="text-red-700">{t("Save failed", "保存に失敗しました")}: {wizardSaveError ?? t("Unknown error", "不明なエラー")}</span>
              )}
              {wizardSaveStatus === "idle" && t("Idle", "待機中")}
              {!canGoNext && nextBlockedReason ? <p className="mt-1 text-xs text-amber-700">{nextBlockedReason}</p> : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-3 py-1.5 text-sm"
                disabled={step <= 1}
                onClick={prevStep}
              >
                {t("Back", "戻る")}
              </button>
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                disabled={!canGoNext}
                onClick={nextStep}
              >
                {t("Next", "次へ")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
