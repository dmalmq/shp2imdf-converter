import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
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
  type UnitMappingState,
  type UpdateFileRequest,
  updateSessionFile,
  uploadCompanyMappings
} from "../api/client";
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
import { useAppStore } from "../store/useAppStore";


const STEP_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const EMPTY_UNIT_MAPPING: UnitMappingState = {
  code_column: null,
  name_column: null,
  alt_name_column: null,
  restriction_column: null,
  accessibility_column: null,
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
    .filter((item) => ["unit", "opening", "fixture", "detail"].includes(item.detected_type ?? ""))
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
  const [step, setStep] = useState(1);
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

  const steps = useMemo(
    () => [
      { id: 1, label: "Project Info" },
      { id: 2, label: "File Classification" },
      { id: 3, label: "Level Mapping" },
      { id: 4, label: "Building Assignment" },
      { id: 5, label: "Unit Mapping" },
      { id: 6, label: openingCount ? "Opening Mapping" : "Opening Mapping (No files)" },
      { id: 7, label: fixtureCount ? "Fixture Mapping" : "Fixture Mapping (No files)" },
      { id: 8, label: detailCount ? "Detail Mapping" : "Detail Mapping (No files)" },
      { id: 9, label: "Footprint Options" },
      { id: 10, label: "Summary" }
    ],
    [detailCount, fixtureCount, openingCount]
  );

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
        const message = error instanceof Error ? error.message : "Failed to load wizard state";
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
  }, [navigate, sessionId, setFiles, setWizardSaveStatus, setWizardState]);

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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Detect all failed";
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
      const message = error instanceof Error ? error.message : "Failed to save file mapping";
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
      const message = error instanceof Error ? error.message : "Failed to save project info";
      setWizardSaveStatus("error", message);
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
      const message = error instanceof Error ? error.message : "Failed to save building assignments";
      setWizardSaveStatus("error", message);
    }
  };

  const saveMappings = async (payload: {
    unit?: UnitMappingState;
    opening?: OpeningMappingState;
    fixture?: FixtureMappingState;
    detail_confirmed?: boolean;
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
      const message = error instanceof Error ? error.message : "Failed to save mappings";
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
      const message = error instanceof Error ? error.message : "Failed to save footprint options";
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to upload company mappings";
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
      navigate("/review");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate draft features";
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
      return <DetailMapStep files={files} />;
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
    const currentIndex = STEP_ORDER.indexOf(step);
    if (currentIndex === -1 || currentIndex >= STEP_ORDER.length - 1) {
      return;
    }
    if (step === 3) {
      void syncLevels();
    }
    const next = STEP_ORDER[currentIndex + 1];
    setStep(next);
  };

  const prevStep = () => {
    const currentIndex = STEP_ORDER.indexOf(step);
    if (currentIndex <= 0) {
      return;
    }
    const previous = STEP_ORDER[currentIndex - 1];
    setStep(previous);
  };

  const canGoNext = step < 10 && (step !== 1 || projectComplete);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-6 px-6 py-7 xl:px-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Wizard</h1>
          <p className="text-sm text-slate-600">
            Session: <span className="font-mono">{sessionId ?? "No active session"}</span>
          </p>
        </div>
        <Link className="rounded bg-slate-700 px-3 py-2 text-sm text-white" to="/">
          Back to Upload
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <StepSidebar
          steps={steps}
          currentStep={step}
          onSelectStep={setStep}
          onSkipToSummary={() => {
            setStep(10);
            void syncLevels();
          }}
        />
        <div className="space-y-5">
          {loading ? (
            <div className="rounded border bg-white p-4 text-sm text-slate-600">Loading wizard data...</div>
          ) : (
            showStep()
          )}

          {learningSuggestion && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <p>{learningSuggestion.message}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs text-white"
                  onClick={() => void applyLearningSuggestion()}
                >
                  Apply Learning
                </button>
                <button
                  type="button"
                  className="rounded border border-amber-400 px-3 py-1.5 text-xs"
                  onClick={() => setLearningSuggestion(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded border bg-white px-5 py-3.5">
            <div className="text-sm">
              {wizardSaveStatus === "saving" && "Saving..."}
              {wizardSaveStatus === "saved" && "Saved ✓"}
              {wizardSaveStatus === "error" && (
                <span className="text-red-700">Save failed: {wizardSaveError ?? "Unknown error"}</span>
              )}
              {wizardSaveStatus === "idle" && "Idle"}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-3 py-1.5 text-sm"
                disabled={step <= 1}
                onClick={prevStep}
              >
                ← Back
              </button>
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                disabled={!canGoNext}
                onClick={nextStep}
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
