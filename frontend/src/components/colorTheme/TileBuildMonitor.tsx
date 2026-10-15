import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { fetchTileJob, tileJobDownloadUrl, type TileJobStatus } from "../../api/client";
import { ApiClientError, toErrorMessage } from "../../api/errors";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { tileProgress } from "../../lib/colorTheme";
import { saveUrl } from "../../lib/download";
import { cn } from "@/lib/utils";

export const TILE_POLL_MS = 1000;
const STORAGE_KEY = "color-theme-tile-build-v1";

export type TileBuildState =
  | { state: "idle" }
  | { state: "active"; jobId: string; job: Extract<TileJobStatus, { state: "queued" | "running" }> | null; trackingError: string | null }
  | { state: "done"; jobId: string; job: Extract<TileJobStatus, { state: "done" }> }
  | { state: "failed"; jobId: string; reason: string; kind: "worker" | "missing" };

type Monitor = { build: TileBuildState; start: (jobId: string) => void; dismiss: () => void };
const TileBuildContext = createContext<Monitor | null>(null);

function readBuild(): TileBuildState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { state: "idle" };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("state" in value) || !("jobId" in value) || typeof value.jobId !== "string") {
      return { state: "idle" };
    }
    if (value.state === "active") return { state: "active", jobId: value.jobId, job: null, trackingError: null };
    if (value.state === "failed" && "reason" in value && typeof value.reason === "string" && "kind" in value &&
      (value.kind === "worker" || value.kind === "missing")) {
      return { state: "failed", jobId: value.jobId, reason: value.reason, kind: value.kind };
    }
    if (value.state === "done" && "job" in value && value.job && typeof value.job === "object" &&
      "state" in value.job && value.job.state === "done" && "filename" in value.job && typeof value.job.filename === "string" &&
      "warnings" in value.job && Array.isArray(value.job.warnings) && value.job.warnings.every((item) => typeof item === "string") &&
      "problems" in value.job && Array.isArray(value.job.problems) && value.job.problems.every((item) => typeof item === "string")) {
      return { state: "done", jobId: value.jobId, job: { state: "done", filename: value.job.filename, warnings: value.job.warnings, problems: value.job.problems } };
    }
  } catch {
    // Storage can be unavailable in private browsing or contain an older shape.
  }
  return { state: "idle" };
}

function persistBuild(build: TileBuildState): void {
  try {
    if (build.state === "idle") sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(build));
  } catch {
    // The in-memory monitor still follows the build for this tab.
  }
}

export function TileBuildProvider({ children }: { children: ReactNode }) {
  const [build, setBuild] = useState<TileBuildState>(readBuild);
  const jobId = build.state === "active" ? build.jobId : null;
  const start = useCallback((id: string) => {
    const next: TileBuildState = { state: "active", jobId: id, job: null, trackingError: null };
    persistBuild(next);
    setBuild(next);
  }, []);
  const dismiss = useCallback(() => {
    persistBuild({ state: "idle" });
    setBuild({ state: "idle" });
  }, []);

  useEffect(() => {
    if (jobId === null) return;
    const request = new AbortController();
    let next: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const job = await fetchTileJob(jobId, request.signal);
        if (request.signal.aborted) return;
        switch (job.state) {
          case "done": {
            const finished: TileBuildState = { state: "done", jobId, job };
            persistBuild(finished);
            setBuild(finished);
            saveUrl(tileJobDownloadUrl(jobId), job.filename);
            return;
          }
          case "failed": {
            const failed: TileBuildState = { state: "failed", jobId, reason: job.reason, kind: "worker" };
            persistBuild(failed);
            setBuild(failed);
            return;
          }
          case "queued":
          case "running":
            setBuild({ state: "active", jobId, job, trackingError: null });
            next = setTimeout(() => void poll(), TILE_POLL_MS);
            return;
        }
      } catch (caught) {
        if (request.signal.aborted) return;
        if (caught instanceof ApiClientError && caught.status === 404) {
          const failed: TileBuildState = { state: "failed", jobId, reason: "", kind: "missing" };
          persistBuild(failed);
          setBuild(failed);
          return;
        }
        const message = toErrorMessage(caught, "Request failed");
        setBuild((current) => current.state === "active" && current.jobId === jobId
          ? { ...current, trackingError: message }
          : current);
        next = setTimeout(() => void poll(), TILE_POLL_MS);
      }
    };
    void poll();
    return () => {
      request.abort();
      clearTimeout(next);
    };
  }, [jobId]);

  const context = useMemo(() => ({ build, start, dismiss }), [build, start, dismiss]);
  return <TileBuildContext.Provider value={context}>{children}</TileBuildContext.Provider>;
}

export function useTileBuild(): Monitor {
  const context = useContext(TileBuildContext);
  if (context === null) throw new Error("useTileBuild must be used within TileBuildProvider");
  return context;
}

export function TileBuildNotice() {
  const { build, dismiss } = useTileBuild();
  const { t } = useUiLanguage();
  if (build.state === "idle") return null;

  const title = build.state === "active"
    ? t("Building vector tiles", "ベクタータイルを作成中")
    : build.state === "done"
      ? t(`Created ${build.job.filename} with vector tiles`, `ベクタータイル付きの ${build.job.filename} を作成しました`)
      : t("Download failed", "ダウンロード失敗");
  const detail = build.state === "active"
    ? build.trackingError
      ? t(`Could not follow the vector tile build: ${build.trackingError}. Retrying…`, `ベクタータイルの作成状況を取得できませんでした: ${build.trackingError}。再試行中…`)
      : tileProgress(build.job, t)
    : build.state === "done"
      ? build.job.problems.length > 0
        ? t(`The download started, but tile checks found ${build.job.problems.length} problems.`, `ダウンロードを開始しましたが、タイルの確認で問題が ${build.job.problems.length} 件見つかりました。`)
        : t("The download started.", "ダウンロードを開始しました。")
      : build.kind === "missing"
        ? t("The server no longer has this vector tile build: it was restarted, or the build expired. Download again to start a new one.", "サーバーにこのベクタータイルの作成がありません。サーバーが再起動したか、期限が切れました。もう一度ダウンロードして作成し直してください。")
        : t(`Vector tiles failed: ${build.reason}`, `ベクタータイルの作成に失敗しました: ${build.reason}`);

  return (
    <div className="sticky top-0 z-30 w-full shrink-0 border-b border-border bg-card px-4 py-3 shadow-sm">
      <section
        role={build.state === "failed" ? "alert" : "status"}
        aria-label={title}
        className={cn(
          "mx-auto flex w-full max-w-5xl items-start gap-3 border-l-2 px-3",
          build.state === "failed" ? "border-destructive text-destructive" : "border-primary text-foreground"
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 whitespace-normal break-words text-xs leading-5 [overflow-wrap:anywhere]">{detail}</p>
          {build.state === "done" ? (
            <a className="mt-2 inline-block text-xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={tileJobDownloadUrl(build.jobId)} download={build.job.filename}>
              {t("Download again", "もう一度ダウンロード")}
            </a>
          ) : null}
        </div>
        {build.state !== "active" ? (
          <button type="button" onClick={dismiss} aria-label={t("Dismiss", "閉じる")}
            className="shrink-0 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("Dismiss", "閉じる")}
          </button>
        ) : null}
      </section>
    </div>
  );
}
