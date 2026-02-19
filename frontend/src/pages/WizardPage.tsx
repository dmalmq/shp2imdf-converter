import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  detectAllFiles,
  fetchSessionFeatures,
  fetchSessionFiles,
  type UpdateFileRequest,
  updateSessionFile
} from "../api/client";
import { FileClassStep } from "../components/wizard/FileClassStep";
import { LevelMapStep } from "../components/wizard/LevelMapStep";
import { StepSidebar } from "../components/wizard/StepSidebar";
import { useAppStore } from "../store/useAppStore";


export function WizardPage() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId);
  const files = useAppStore((state) => state.files);
  const setFiles = useAppStore((state) => state.setFiles);
  const selectedFileStem = useAppStore((state) => state.selectedFileStem);
  const setSelectedFileStem = useAppStore((state) => state.setSelectedFileStem);
  const hoveredFileStem = useAppStore((state) => state.hoveredFileStem);
  const setHoveredFileStem = useAppStore((state) => state.setHoveredFileStem);
  const wizardSaveStatus = useAppStore((state) => state.wizardSaveStatus);
  const wizardSaveError = useAppStore((state) => state.wizardSaveError);
  const setWizardSaveStatus = useAppStore((state) => state.setWizardSaveStatus);
  const learningSuggestion = useAppStore((state) => state.learningSuggestion);
  const setLearningSuggestion = useAppStore((state) => state.setLearningSuggestion);
  const [step, setStep] = useState(2);
  const [loading, setLoading] = useState(false);
  const [features, setFeatures] = useState<
    {
      type: string;
      feature_type?: string;
      geometry?: { type: string; coordinates: unknown } | null;
      properties?: { source_file?: string; [key: string]: unknown };
    }[]
  >([]);

  const steps = useMemo(
    () => [
      { id: 1, label: "Project Info", enabled: false },
      { id: 2, label: "File Classification" },
      { id: 3, label: "Level Mapping" },
      { id: 10, label: "Summary (Phase 3)", enabled: false }
    ],
    []
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
        const [fileResponse, featureResponse] = await Promise.all([
          fetchSessionFiles(sessionId),
          fetchSessionFeatures(sessionId)
        ]);
        if (!active) {
          return;
        }
        setFiles(fileResponse.files);
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
  }, [navigate, sessionId, setFiles, setWizardSaveStatus]);

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

  const showStep = () => {
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

    return (
      <section className="rounded border bg-white p-6">
        <h2 className="text-lg font-semibold">Step not available in Phase 2</h2>
        <p className="mt-2 text-sm text-slate-600">
          Project Info and Summary become functional in Phase 3.
        </p>
      </section>
    );
  };

  const nextStep = () => {
    if (step === 2) {
      setStep(3);
      return;
    }
  };

  const prevStep = () => {
    if (step === 3) {
      setStep(2);
      return;
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 p-6">
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

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <StepSidebar
          steps={steps}
          currentStep={step}
          onSelectStep={setStep}
          onSkipToSummary={() => setStep(10)}
        />
        <div className="space-y-4">
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

          <div className="flex items-center justify-between rounded border bg-white px-4 py-3">
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
                disabled={step <= 2}
                onClick={prevStep}
              >
                ← Back
              </button>
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                disabled={step >= 3}
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
