import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";

import { fetchProjects, importImdf, type ProjectListResponse } from "../api/client";
import { toErrorMessage } from "../api/errors";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast } from "../components/shared/ToastProvider";
import { StageBars } from "../components/shell/StageTrack";
import { NEW_PROJECT_PATH, projectPath } from "../components/shell/stages";
import { Button } from "../components/ui/button";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { formatClock } from "../lib/clock";
import {
  ARTWORK_PATH,
  hubProjects,
  lifetime,
  matchesFilter,
  routeDroppedFiles,
  type DroppedFiles,
  type HubFilter,
  type HubProject
} from "../lib/hub";
import { useAppStore } from "../store/useAppStore";
import { cn } from "@/lib/utils";

type T = (en: string, ja: string) => string;

type Listing =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; response: ProjectListResponse };

function formatDay(iso: string, language: "en" | "ja", t: T, now = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return `${t("Today", "今日")} ${formatClock(date.getTime())}`;
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-GB", options).format(date);
}

/** Home: the station projects kept on this PC, and the ways to start another. */
export function HubPage() {
  const { t } = useUiLanguage();
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setListing({ state: "loading" });
    fetchProjects().then(
      (response) => {
        if (active) setListing({ state: "loaded", response });
      },
      (error: unknown) => {
        if (active) setListing({ state: "failed", message: toErrorMessage(error, "The project list did not load") });
      }
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <div className="flex items-start gap-10 px-14 py-10">
      <section aria-labelledby="hub-projects" className="flex min-w-0 flex-1 flex-col gap-[18px]">
        {listing.state === "loaded" ? (
          <ProjectList response={listing.response} />
        ) : (
          <>
            <HubHeading />
            {listing.state === "loading" ? (
              <div aria-busy="true" aria-label={t("Loading projects", "プロジェクトを読み込んでいます")} className="flex flex-col gap-[18px]">
                <SkeletonBlock className="h-[140px] w-full rounded-2xl" />
                <SkeletonBlock className="h-[140px] w-full rounded-2xl" />
              </div>
            ) : (
              <div role="alert" className="rounded-2xl border border-border bg-card px-7 py-6">
                <h2 className="text-base font-semibold text-foreground">
                  {t("Could not load the projects", "プロジェクトを読み込めませんでした")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{listing.message}</p>
                <Button className="mt-4" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                  {t("Try again", "再試行")}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
      <StartNew />
    </div>
  );
}

function HubHeading({ children, subtitle }: { children?: React.ReactNode; subtitle?: string }) {
  const { t } = useUiLanguage();
  return (
    <div className="flex items-end gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 id="hub-projects" className="font-display text-[34px] font-semibold leading-[42px] text-foreground">
          {t("Station projects", "駅プロジェクト")}
        </h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

const FILTERS: ReadonlyArray<{ id: HubFilter; en: string; ja: string }> = [
  { id: "all", en: "All", ja: "すべて" },
  { id: "in-progress", en: "In progress", ja: "作業中" },
  { id: "delivered", en: "Delivered", ja: "書き出し済み" }
];

function keptFor(response: ProjectListResponse, t: T): string {
  const phrase = (limits: ProjectListResponse["limits"]["sessions"]) => {
    const { unit, value } = lifetime(limits);
    return unit === "days" ? t(`${value} days`, `${value} 日間`) : t(`${value} hours`, `${value} 時間`);
  };
  const sessions = phrase(response.limits.sessions);
  const artwork = phrase(response.limits.artwork);
  const base = t(
    `Projects are kept for ${sessions} after they were last opened.`,
    `プロジェクトは最後に開いてから ${sessions}保存されます。`
  );
  return sessions === artwork ? base : `${base} ${t(`Artwork: ${artwork}.`, `図面: ${artwork}。`)}`;
}

function ProjectList({ response }: { response: ProjectListResponse }) {
  const { t } = useUiLanguage();
  const [filter, setFilter] = useState<HubFilter>("all");
  const projects = hubProjects(response.projects);
  const shown = projects.filter((project) => matchesFilter(project, filter));
  const kept = keptFor(response, t);

  if (projects.length === 0) {
    return (
      <>
        <HubHeading subtitle={t("Nothing on this PC yet", "このPCにはまだありません")} />
        <div className="rounded-2xl border border-dashed border-input px-7 py-10 text-center">
          <h2 className="text-base font-semibold text-foreground">
            {t("No projects on this PC yet", "このPCにはまだプロジェクトがありません")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm leading-5 text-muted-foreground">
            {t(
              "Start one from the routes on the right, or drop files there.",
              "右のいずれかから始めるか、そこにファイルをドロップしてください。"
            )}
          </p>
          <p className="mx-auto mt-3 max-w-md text-xs text-muted-foreground">{kept}</p>
        </div>
      </>
    );
  }

  const count = response.total;
  const subtitle =
    projects.length < count
      ? t(`Showing ${projects.length} of ${count} projects on this PC · most recently opened first`, `このPCのプロジェクト ${count} 件中 ${projects.length} 件 · 最近開いた順`)
      : t(
          `${count} ${count === 1 ? "project" : "projects"} on this PC · most recently opened first`,
          `このPCのプロジェクト ${count} 件 · 最近開いた順`
        );

  return (
    <>
      <HubHeading subtitle={subtitle}>
        <div role="group" aria-label={t("Show", "表示")} className="flex shrink-0 gap-1.5">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-5 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === item.id
                  ? "bg-foreground text-background"
                  : "bg-muted text-foreground/80 hover:text-foreground"
              )}
            >
              {t(item.en, item.ja)}
            </button>
          ))}
        </div>
      </HubHeading>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-[18px]" aria-label={t("Projects", "プロジェクト")}>
          {shown.map((project, index) => (
            <ProjectCard key={`${project.flow}:${project.id}`} project={project} latest={index === 0 && filter === "all"} />
          ))}
        </ul>
      ) : (
        <p className="rounded-2xl border border-border bg-card px-7 py-6 text-sm text-muted-foreground">
          {t("No projects match this filter.", "該当するプロジェクトはありません。")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{kept}</p>
    </>
  );
}

function flowPill(project: HubProject, t: T): string {
  if (project.flow === "artwork") return t("Artwork → Shapefiles", "図面 → シェープファイル");
  if (project.imdfShapefiles) return t("IMDF shapefiles → ODC 2026", "IMDF シェープファイル → ODC 2026");
  return t("Shapefiles → IMDF", "シェープファイル → IMDF");
}

function StatusLine({ project }: { project: HubProject }) {
  const { t, uiLanguage } = useUiLanguage();
  const { status } = project;
  let tone = "text-muted-foreground";
  let dot = "bg-muted-foreground";
  let text: string;

  if (status.kind === "delivered") {
    const day = formatDay(status.at, uiLanguage, t);
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-primary">
        <Check aria-hidden="true" className="h-4 w-4 rounded-full bg-primary p-0.5 text-primary-foreground" strokeWidth={3} />
        {t(`Delivered ${day}`, `${day} に書き出し済み`)}
      </p>
    );
  }
  if (status.kind === "to-fix") {
    tone = "text-destructive";
    dot = "bg-destructive";
    text = t(
      `${status.count} ${status.count === 1 ? "thing" : "things"} to fix before you can deliver`,
      `書き出し前に修正が必要な項目 ${status.count} 件`
    );
  } else if (status.kind === "to-place") {
    tone = "text-warning-foreground";
    dot = "bg-warning-foreground";
    text = t(
      `${status.count} ${status.count === 1 ? "floor" : "floors"} still to place`,
      `未配置のフロア ${status.count} 件`
    );
  } else if (status.kind === "ready") {
    tone = "text-primary";
    dot = "bg-primary";
    text =
      status.canWait > 0
        ? t(`Nothing to fix · ${status.canWait} can wait`, `修正不要 · 後回しにできる項目 ${status.canWait} 件`)
        : t("Nothing to fix · ready to deliver", "修正不要 · 書き出しできます");
  } else {
    text = t("Not checked yet", "まだチェックしていません");
  }

  return (
    <p className={cn("flex items-center gap-2 text-sm font-medium", tone)}>
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
      {text}
    </p>
  );
}

function ProjectCard({ project, latest }: { project: HubProject; latest: boolean }) {
  const { t, uiLanguage } = useUiLanguage();
  const navigate = useNavigate();
  const current = project.track[project.stageNumber - 1];
  const stageLine =
    project.action === "open"
      ? t("Delivered · all four stages done", "書き出し済み · 4ステージ完了")
      : t(
          `Stage ${project.stageNumber} of 4 · ${current.label.en}`,
          `ステージ ${project.stageNumber}/4 · ${current.label.ja}`
        );
  const title = project.name ?? t("Unnamed project", "名前のないプロジェクト");
  const actionLabel = project.action === "open" ? t("Open", "開く") : t("Continue →", "続ける →");
  const changedDay = project.deliveredBeforeChanges ? formatDay(project.deliveredBeforeChanges, uiLanguage, t) : null;

  return (
    <li
      className={cn(
        "flex items-center gap-7 rounded-2xl bg-card px-7 py-6",
        latest ? "border-[1.5px] border-primary" : "border border-border"
      )}
    >
      <div className="flex w-[200px] shrink-0 flex-col gap-1">
        <h2 className="truncate font-display text-[26px] font-semibold leading-8 text-foreground" title={title}>
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">
          {project.name ? null : <span className="font-mono">{project.id.slice(0, 8)} · </span>}
          {stageLine}
        </p>
        <span className="mt-1.5 self-start rounded-full bg-muted px-2.5 py-[3px] text-[11px] font-medium text-foreground/80">
          {flowPill(project, t)}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <StageBars stages={project.track} />
        <StatusLine project={project} />
        {changedDay ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            {t(`Delivered ${changedDay} · changed since`, `${changedDay} に書き出し済み · その後に変更あり`)}
          </p>
        ) : null}
      </div>

      <div className="flex w-[140px] shrink-0 flex-col items-end gap-1">
        <span className="text-[11px] text-muted-foreground">{t("Last opened", "最後に開いた日")}</span>
        <span className="whitespace-nowrap text-[13px] font-medium text-foreground">
          {formatDay(project.lastOpened, uiLanguage, t)}
        </span>
        <Button
          className="mt-2 rounded-[10px] text-[13px] font-semibold"
          variant={latest ? "default" : "outline"}
          aria-label={`${actionLabel.replace(" →", "")} ${title}`}
          onClick={() => navigate(project.href)}
        >
          {actionLabel}
        </Button>
      </div>
    </li>
  );
}

function RouteCard({
  title,
  description,
  formats,
  icon,
  disabled,
  onClick
}: {
  title: string;
  description: string;
  formats: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3.5 rounded-xl border border-border bg-card p-[18px] text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled ? "opacity-60" : "hover:bg-accent"
      )}
    >
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] font-semibold text-foreground">{title}</span>
        <span className="text-[13px] leading-[1.45] text-foreground/80">{description}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{formats}</span>
      </span>
    </button>
  );
}

const HOW: ReadonlyArray<{ en: string; ja: string }> = [
  { en: "Bring in — read the per‑floor files", ja: "取り込み — フロアごとのファイルを読み込む" },
  { en: "Set up — describe the station and its floors", ja: "設定 — 駅とフロアの情報を入力する" },
  { en: "Check — fix what’s wrong, on the map", ja: "チェック — 問題を地図上で修正する" },
  { en: "Deliver — pick the outputs you need", ja: "書き出し — 必要な出力を選ぶ" }
];

function StartNew() {
  const { t } = useUiLanguage();
  const navigate = useNavigate();
  const pushToast = useToast();
  const handleApiError = useApiErrorHandler();
  const imdfInput = useRef<HTMLInputElement>(null);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const openImdf = useCallback(
    async (file: File) => {
      setOpening(true);
      setProblem(null);
      try {
        const payload = await importImdf(file);
        const store = useAppStore.getState();
        store.setSessionExpiredMessage(null);
        store.switchProject(payload.session_id);
        store.projectLoaded(payload.session_id, { importProfile: "standard", files: [], reviewReached: true });
        pushToast({
          title: t("IMDF archive opened", "IMDFアーカイブを開きました"),
          description: t(`${payload.feature_count} features loaded.`, `${payload.feature_count} 件のフィーチャーを読み込みました。`),
          variant: "success"
        });
        navigate(projectPath(payload.session_id, "check"));
      } catch (caught) {
        setProblem(
          handleApiError(caught, t("Failed to open IMDF archive", "IMDFアーカイブを開けませんでした"), {
            title: t("Open failed", "オープン失敗")
          })
        );
      } finally {
        setOpening(false);
      }
    },
    [handleApiError, navigate, pushToast, t]
  );

  const onDrop = useCallback(
    async (files: File[]) => {
      setProblem(null);
      const decision = await routeDroppedFiles(files);
      if (decision.route === "imdf") {
        await openImdf(decision.files[0]);
      } else if (decision.route) {
        const state: DroppedFiles = { droppedFiles: decision.files };
        navigate(decision.route === "artwork" ? ARTWORK_PATH : NEW_PROJECT_PATH, { state });
      } else if (decision.reason === "mixed") {
        setProblem(
          t(
            "Those files belong to different routes. Drop shapefiles, one artwork file, or one IMDF archive.",
            "種類の異なるファイルが含まれています。シェープファイル、図面1点、または IMDF アーカイブ1点をドロップしてください。"
          )
        );
      } else if (decision.reason === "several") {
        setProblem(t("Drop one artwork file or IMDF archive at a time.", "図面や IMDF アーカイブは1点ずつドロップしてください。"));
      } else {
        setProblem(
          t(
            "None of those files can be brought in: use shapefiles, .gpkg, .zip, .ai, .pdf or .imdf.",
            "取り込めるファイルがありません。シェープファイル、.gpkg、.zip、.ai、.pdf、.imdf を使用してください。"
          )
        );
      }
    },
    [navigate, openImdf, t]
  );

  const { getRootProps, getInputProps, open, isDragActive } = useDropzone({
    onDrop: (files) => void onDrop(files),
    noClick: true,
    noKeyboard: true,
    disabled: opening
  });

  return (
    <section
      {...getRootProps({ "aria-labelledby": "hub-start" })}
      className="flex w-[400px] shrink-0 flex-col gap-3.5"
    >
      <input {...getInputProps()} data-testid="hub-drop-input" />
      <input
        ref={imdfInput}
        id="imdf-file-input"
        type="file"
        accept=".imdf,.zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openImdf(file);
          event.target.value = "";
        }}
      />
      <h2 id="hub-start" className="font-display text-[22px] font-semibold leading-[27px] text-foreground">
        {t("Start something new", "新しく始める")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("What are you starting from?", "何から始めますか？")}</p>

      <RouteCard
        title={t("From floor shapefiles", "フロアのシェープファイルから")}
        description={t(
          "Turn CAD/GIS floor files into an IMDF archive for Apple Indoor Maps.",
          "CAD/GIS のフロアファイルを Apple Indoor Maps 用の IMDF アーカイブに変換します。"
        )}
        formats=".shp .dbf .shx .prj · .zip · .gpkg"
        onClick={() => navigate(NEW_PROJECT_PATH)}
        icon={
          <span className="flex h-10 w-10 flex-col items-center justify-center gap-[3px] rounded-[10px] bg-accent">
            {[0, 1, 2].map((bar) => (
              <span key={bar} className="h-1 w-5 rounded-[1px] bg-primary" />
            ))}
          </span>
        }
      />
      <RouteCard
        title={t("From Illustrator artwork", "Illustrator 図面から")}
        description={t(
          "Place floor drawings on the map and get georeferenced shapefiles.",
          "フロア図面を地図上に配置し、座標付きのシェープファイルを作成します。"
        )}
        formats=".ai · .pdf"
        onClick={() => navigate(ARTWORK_PATH)}
        icon={
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-info-muted">
            <span className="h-[18px] w-[18px] rounded-full border-2 border-info" />
          </span>
        }
      />
      <RouteCard
        title={opening ? t("Opening…", "開いています…") : t("Reopen an IMDF archive", "IMDF アーカイブを開き直す")}
        description={t("Keep editing something that was already exported.", "書き出し済みのデータを引き続き編集します。")}
        formats=".imdf · .zip"
        disabled={opening}
        onClick={() => imdfInput.current?.click()}
        icon={
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-muted">
            <span className="h-5 w-4 rounded-[3px] bg-foreground/70" />
          </span>
        }
      />

      <button
        type="button"
        onClick={open}
        className={cn(
          "rounded-xl border border-dashed p-[18px] text-center text-[13px] leading-[1.45] transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isDragActive ? "border-primary bg-accent text-foreground" : "border-input text-muted-foreground hover:bg-card"
        )}
      >
        {isDragActive
          ? t("Drop to start", "ドロップして開始")
          : t(
              "Or drop files here — we’ll work out which of these you need.",
              "またはここにファイルをドロップ — どれで始めるかを判別します。"
            )}
      </button>
      {problem ? (
        <p role="alert" className="rounded-md bg-destructive-muted px-3 py-2 text-xs text-destructive">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 px-1 pt-2">
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
          {t("How a project goes", "プロジェクトの流れ")}
        </h3>
        <ol className="flex flex-col gap-2">
          {HOW.map((step, index) => (
            <li key={step.en} className="flex items-center gap-2.5 text-[13px] text-foreground/80">
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold"
              >
                {index + 1}
              </span>
              {t(step.en, step.ja)}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
