import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDropzone } from "react-dropzone";
import { Link, useNavigate } from "react-router-dom";

import { importImdfShapefiles, importShapefiles, updateSessionFile, type UpdateFileRequest } from "../api/client";
import { DetectedTable, QueuedTable } from "../components/bringIn/FileTable";
import { NextBar } from "../components/bringIn/NextBar";
import { FloorsFound, ProfileChoice, WhyGuesses } from "../components/bringIn/Rail";
import { useToast } from "../components/shared/ToastProvider";
import { usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { NEW_PROJECT_PATH, projectPath } from "../components/shell/stages";
import { Button } from "../components/ui";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  ACCEPTED_EXTENSIONS,
  addToQueue,
  bringInView,
  datasetKey,
  floorChoices,
  isAccepted,
  projectNextStep,
  queueNextStep,
  queuedDatasets,
  type NextStep
} from "../lib/bringIn";
import { useAppStore, useSessionAction, type ImportProfile } from "../store/useAppStore";
import { cn } from "@/lib/utils";

const DROPZONE_ACCEPT = {
  "application/octet-stream": [".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix"],
  "application/geopackage+sqlite3": [".gpkg"],
  "application/x-sqlite3": [".gpkg"],
  "application/zip": [".zip"]
} as const;

type UploadPageProps = {
  /** A project's Bring in, showing what was read. Otherwise `/p/new`, which starts from no project. */
  fromProject?: boolean;
};

export function UploadPage({ fromProject = false }: UploadPageProps = {}) {
  return fromProject ? <BroughtIn /> : <NewBringIn />;
}

function Layout({
  intro,
  pills,
  main,
  rail,
  bar
}: {
  intro: string;
  pills?: ReactNode;
  main: ReactNode;
  rail: ReactNode;
  bar: ReactNode;
}) {
  const { t } = useUiLanguage();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 items-start gap-8 overflow-auto px-14 pb-6 pt-7">
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <h1 className="font-display text-[30px] font-semibold leading-tight text-foreground">
            {t("Bring in the floor files", "フロアのファイルを取り込む")}
          </h1>
          <p className="max-w-[46rem] text-[15px] leading-[1.55] text-muted-foreground">{intro}</p>
          {pills}
          {main}
        </main>
        <aside className="flex w-[360px] shrink-0 flex-col gap-4">{rail}</aside>
      </div>
      {bar}
    </div>
  );
}

function Pill({ tone = "plain", children }: { tone?: "plain" | "ok" | "danger"; children: ReactNode }) {
  return (
    <li
      className={cn(
        "rounded-full px-3 py-[5px] text-xs font-medium",
        tone === "plain" && "bg-muted text-muted-foreground",
        tone === "ok" && "bg-accent text-primary",
        tone === "danger" && "bg-destructive-muted text-destructive"
      )}
    >
      {children}
    </li>
  );
}

/** The top bar offers the bar's button while the bar's own is out of view. */
function useNextAction(step: NextStep, run: () => void, busy: boolean) {
  const { t } = useUiLanguage();
  const anchor = useRef<HTMLDivElement>(null);
  usePrimaryAction({
    label: t(step.action.en, step.action.ja),
    run,
    disabledReason: step.blocked ? t(step.blocked.en, step.blocked.ja) : null,
    busy,
    anchor
  });
  return anchor;
}

function NewBringIn() {
  const navigate = useNavigate();
  const switchProject = useAppStore((state) => state.switchProject);
  const projectLoaded = useAppStore((state) => state.projectLoaded);
  const setCleanupSummary = useAppStore((state) => state.setCleanupSummary);
  const setSessionExpiredMessage = useAppStore((state) => state.setSessionExpiredMessage);
  const pushToast = useToast();
  const handleApiError = useApiErrorHandler();
  const { t } = useUiLanguage();

  const dropped = useDroppedFiles();
  const [queued, setQueued] = useState<File[]>(() => addToQueue([], dropped.filter(isAccepted)));
  const [profile, setProfile] = useState<ImportProfile>("standard");
  const [preferFilenameFloor, setPreferFilenameFloor] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    switchProject(null);
  }, [switchProject]);

  const onDrop = (accepted: File[], rejected: Array<{ file: File }>) => {
    const usable = accepted.filter(isAccepted);
    if (usable.length > 0) setQueued((previous) => addToQueue(previous, usable));
    const skipped = rejected.length + accepted.length - usable.length;
    if (skipped > 0) {
      pushToast({
        title: t("Some files were left out", "一部のファイルを除外しました"),
        description: t(
          `${skipped} file(s) are not shapefile parts, GeoPackages or zip archives.`,
          `${skipped} 件はシェープファイルの構成ファイル・GeoPackage・zip ではありません。`
        ),
        variant: "info"
      });
    }
  };
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    multiple: true,
    accept: DROPZONE_ACCEPT
  });

  const datasets = useMemo(() => queuedDatasets(queued), [queued]);
  const step = queueNextStep(datasets, profile);

  const runImport = async () => {
    if (step.blocked || progress !== null) return;
    setProgress(0);
    try {
      const payload =
        profile === "imdf_shapefile"
          ? await importImdfShapefiles(queued, setProgress, preferFilenameFloor)
          : await importShapefiles(queued, setProgress);
      const imdf = payload.import_profile === "imdf_shapefile";
      setSessionExpiredMessage(null);
      switchProject(payload.session_id);
      projectLoaded(payload.session_id, {
        importProfile: payload.import_profile,
        files: payload.files,
        reviewReached: imdf
      });
      setCleanupSummary(payload.cleanup_summary);
      if (payload.warnings.length > 0) {
        pushToast({
          title: t("Import warnings", "インポート警告"),
          description: t(
            `${payload.warnings.length} warning(s) reported during import.`,
            `インポート中に ${payload.warnings.length} 件の警告がありました。`
          ),
          variant: "info"
        });
      }
      navigate(projectPath(payload.session_id, imdf ? "check" : "bring-in"), { replace: true });
    } catch (caught) {
      handleApiError(caught, t("Import failed", "インポートに失敗しました"), { title: t("Import failed", "インポート失敗") });
      setProgress(null);
    }
  };

  const anchor = useNextAction(step, () => void runImport(), progress !== null);

  return (
    <Layout
      intro={t(
        "Drop every floor’s files here. We read each one and guess what it holds and which floor it belongs to, from names like JRTokyoSta_1_Space.",
        "全フロアのファイルをここにドロップしてください。JRTokyoSta_1_Space のような名前から、各ファイルの種類と階を推定します。"
      )}
      main={
        <>
          <div
            {...getRootProps()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[14px] border border-dashed px-6 py-8 text-center transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isDragActive ? "border-primary bg-accent" : "border-input bg-card hover:border-primary/50"
            )}
          >
            <input {...getInputProps()} />
            <p className="text-sm font-medium text-foreground">
              {isDragActive
                ? t("Drop to add them", "ドロップして追加")
                : t("Drop files here or click to browse", "ファイルをドロップまたはクリックして選択")}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{ACCEPTED_EXTENSIONS.join(" ")}</p>
          </div>
          {datasets.length > 0 ? (
            <QueuedTable
              datasets={datasets}
              onAddParts={open}
              onLeaveOut={(key) => setQueued((previous) => previous.filter((file) => datasetKey(file) !== key))}
            />
          ) : null}
        </>
      }
      rail={
        <>
          <ProfileChoice
            value={profile}
            onChange={setProfile}
            imdfOptions={
              <label className="flex items-start gap-2 text-xs leading-[1.45] text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  checked={preferFilenameFloor}
                  onChange={(event) => setPreferFilenameFloor(event.target.checked)}
                />
                <span>
                  {t(
                    "Prefer the floor in the filename when it disagrees with the source level",
                    "ファイル名の階がソースのレベルと異なる場合はファイル名の階を優先"
                  )}
                </span>
              </label>
            }
          />
          <FloorsFound floors={null} />
          <WhyGuesses />
        </>
      }
      bar={<NextBar ref={anchor} step={step} progress={progress} onGo={() => void runImport()} />}
    />
  );
}

function BroughtIn() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId);
  const files = useAppStore((state) => state.files);
  const profile = useAppStore((state) => state.importProfile);
  const upsertFile = useSessionAction(sessionId, (state) => state.upsertFile);
  const handleApiError = useApiErrorHandler();
  const { t } = useUiLanguage();
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const latest = useRef(new Map<string, number>());
  const sent = useRef(0);

  const view = useMemo(() => {
    const read = bringInView(files);
    // IMDF-schema files are taken as they are; nothing about them is a guess.
    return profile === "imdf_shapefile" ? { ...read, needsYou: [], looksRight: [...read.needsYou, ...read.looksRight] } : read;
  }, [files, profile]);
  const step = projectNextStep(view, profile);

  const resolve = async (stem: string, payload: UpdateFileRequest) => {
    if (!sessionId) return;
    const request = ++sent.current;
    latest.current.set(stem, request);
    setSaving((previous) => new Set(previous).add(stem));
    try {
      const response = await updateSessionFile(sessionId, stem, payload);
      if (latest.current.get(stem) === request) upsertFile(response.file);
    } catch (caught) {
      handleApiError(caught, t("Could not save that choice", "選択を保存できませんでした"), {
        title: t("Not saved", "保存されませんでした")
      });
    } finally {
      if (latest.current.get(stem) === request) {
        latest.current.delete(stem);
        setSaving((previous) => {
          const next = new Set(previous);
          next.delete(stem);
          return next;
        });
      }
    }
  };

  const go = () => {
    if (sessionId && !step.blocked && step.goes !== "import") navigate(projectPath(sessionId, step.goes));
  };
  const anchor = useNextAction(step, go, saving.size > 0);
  usePageShell({ bringInNeeds: view.needsYou.length });

  const floorCount = view.floors.length;
  return (
    <Layout
      intro={t(
        "We read every file and guessed what it holds and which floor it belongs to, from names like JRTokyoSta_1_Space. Check the guesses — any of them can be changed, now or later.",
        "すべてのファイルを読み、JRTokyoSta_1_Space のような名前から種類と階を推定しました。推定を確認してください。あとからでも変更できます。"
      )}
      pills={
        <ul className="flex flex-wrap gap-2" aria-label={t("What was read", "読み込み結果")}>
          <Pill>{t(`${view.filesRead} ${view.filesRead === 1 ? "file" : "files"} read`, `${view.filesRead} ファイルを読み込み`)}</Pill>
          <Pill>{t(`${floorCount} ${floorCount === 1 ? "floor" : "floors"} found`, `${floorCount} 階を検出`)}</Pill>
          <Pill tone="ok">
            {t(`${view.looksRight.length} ${view.looksRight.length === 1 ? "looks" : "look"} right`, `問題なし ${view.looksRight.length}`)}
          </Pill>
          {view.needsYou.length > 0 ? (
            <Pill tone="danger">
              {t(`${view.needsYou.length} ${view.needsYou.length === 1 ? "needs" : "need"} you`, `要確認 ${view.needsYou.length}`)}
            </Pill>
          ) : null}
        </ul>
      }
      main={
        <>
          <DetectedTable
            needsYou={view.needsYou}
            looksRight={view.looksRight}
            floorChoices={floorChoices(view.floors)}
            saving={saving}
            onResolve={(stem, payload) => void resolve(stem, payload)}
          />
          <p className="text-[13px] text-muted-foreground">
            {t("Other files are a new project: ", "別のファイルは新しいプロジェクトになります：")}
            <Link to={NEW_PROJECT_PATH} className="font-medium text-primary hover:underline">
              {t("bring in other files", "別のファイルを取り込む")}
            </Link>
          </p>
        </>
      }
      rail={
        <>
          <ProfileChoice value={profile} />
          <FloorsFound floors={view.floors} />
          <WhyGuesses />
        </>
      }
      bar={
        <NextBar
          ref={anchor}
          step={step}
          onGo={go}
          secondary={
            <Button variant="ghost" className="text-primary" asChild>
              <Link to="/">{t("Save and leave", "保存して閉じる")}</Link>
            </Button>
          }
        />
      }
    />
  );
}
