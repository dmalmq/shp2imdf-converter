import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, useParams } from "react-router-dom";

import { fetchSessionFeatures, fetchSessionFiles, fetchWizardState } from "../api/client";
import { isSessionNotFoundError, toErrorMessage } from "../api/errors";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import {
  isShapefileStage,
  landingStage,
  projectPath,
  stageReachable,
  type ShapefileProject
} from "../components/shell/stages";
import { Button } from "../components/ui/button";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";
import { ReviewPage } from "./ReviewPage";
import { UploadPage } from "./UploadPage";
import { WizardPage } from "./WizardPage";

/**
 * Whether a draft was generated at some point. Opening Set up re-sends the
 * levels, and every wizard write resets `generation_status`, but the drafted
 * features stay; without this, a reload on Check after a look at Set up
 * would be sent back to Set up.
 *
 * Source features carry their file's detected type before any generation,
 * and "level" is one of those, so a level is no proof. Footprints come only
 * from the generator: the detector and the classification list never assign
 * that type. Goes once the server keeps the stage (generation no longer reset
 * by wizard resends).
 */
async function hasDraft(sessionId: string): Promise<boolean> {
  const response = await fetchSessionFeatures(sessionId);
  return (response.features as Array<{ feature_type?: unknown }>).some((item) => item.feature_type === "footprint");
}

/**
 * A shapefile project addressed by URL. The URL's id is the project; the
 * store caches it for the pages, which keep reading `sessionId` from there.
 *
 * On a change of id the previous project's pages unmount first, in the same
 * commit that drops them, so their unmount saves go out against the id they
 * were opened with. Only then does the effect switch the store over, which
 * clears everything the previous project left in it.
 */
export function ProjectLayout() {
  const { sessionId: id = "" } = useParams();
  const storeId = useAppStore((state) => state.sessionId);
  const loadedId = useAppStore((state) => state.loadedSessionId);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { t } = useUiLanguage();

  useEffect(() => {
    const state = useAppStore.getState();
    if (state.sessionId === id && state.loadedSessionId === id) return;
    state.switchProject(id);
    setFailure(null);
    let active = true;
    const load = async () => {
      const [fileResponse, wizardResponse] = await Promise.all([fetchSessionFiles(id), fetchWizardState(id)]);
      const importProfile = fileResponse.import_profile ?? "standard";
      const wizard = wizardResponse.wizard;
      return {
        importProfile,
        files: fileResponse.files,
        wizardState: wizard,
        reviewReached:
          importProfile === "imdf_shapefile" ||
          wizard.generation_status !== "not_started" ||
          (fileResponse.files.length > 0 && (await hasDraft(id)))
      };
    };
    load().then(
      (project) => {
        if (active) useAppStore.getState().projectLoaded(id, project);
      },
      (error: unknown) => {
        if (!active) return;
        if (isSessionNotFoundError(error)) {
          useAppStore.getState().setSessionExpiredMessage(toErrorMessage(error, "Project not found"));
          return;
        }
        setFailure({ id, message: toErrorMessage(error, "Could not open the project") });
      }
    );
    return () => {
      active = false;
    };
  }, [id, attempt]);

  if (storeId === id && loadedId === id) {
    return <Outlet key={id} />;
  }

  if (failure?.id === id) {
    return (
      <div role="alert" className="mx-auto mt-16 w-full max-w-md rounded border bg-card p-5">
        <h2 className="text-lg font-semibold">{t("Could not open this project", "プロジェクトを開けませんでした")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{failure.message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" asChild>
            <Link to="/">{t("Back to projects", "プロジェクト一覧へ戻る")}</Link>
          </Button>
          <Button onClick={() => setAttempt((value) => value + 1)}>{t("Try again", "再試行")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div aria-busy="true" aria-label={t("Opening project", "プロジェクトを開いています")} className="space-y-3 p-8">
      <SkeletonBlock className="h-10 w-1/3" />
      <SkeletonBlock className="h-40 w-full" />
    </div>
  );
}

/**
 * Draws the stage the URL names, or sends a stage-less or unreachable URL on
 * to where the project can be opened. `landingStage` only returns reachable
 * stages, so a redirect lands and stays.
 */
export function ProjectStage() {
  const { sessionId = "", stage } = useParams();
  const importProfile = useAppStore((state) => state.importProfile);
  const reviewReached = useAppStore((state) => state.currentScreen === "review");
  const project: ShapefileProject = { importProfile, reviewReached };

  if (!isShapefileStage(stage) || !stageReachable(stage, project)) {
    return <Navigate replace to={projectPath(sessionId, landingStage(project))} />;
  }
  if (stage === "bring-in") return <UploadPage fromProject />;
  if (stage === "set-up") return <WizardPage />;
  // Check and Deliver are one page, so moving between them keeps it mounted.
  return <ReviewPage stage={stage} />;
}

/** The pre-project routes, kept so bookmarks and muscle memory still land. */
export function LegacyStageRedirect({ stage }: { stage: "set-up" | "check" }) {
  const sessionId = useAppStore((state) => state.sessionId);
  return <Navigate replace to={sessionId ? projectPath(sessionId, stage) : "/"} />;
}
