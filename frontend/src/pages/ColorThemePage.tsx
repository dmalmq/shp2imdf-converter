import { AlertTriangle, CheckCircle2, ChevronRight, FileArchive, FolderOpen } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useDropzone } from "react-dropzone";

import {
  convertColorTheme,
  fetchColorTheme,
  inspectColorTheme,
  type ColorThemeInspection,
  type ColorThemeLayer,
  type ColorThemeRenderer,
  type ColorThemeReport,
  type ColorThemeStyleFile
} from "../api/client";
import { toErrorMessage } from "../api/errors";
import { NextBar } from "../components/bringIn/NextBar";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast } from "../components/shared/ToastProvider";
import { usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { Button, Checkbox, Metric } from "../components/ui";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  categoryRange,
  colorThemeReducer,
  colorThemeStage,
  datasetFiles,
  downloadBlockedReason,
  fieldPresence,
  inGeodatabase,
  initialColorThemeState,
  keptGroups,
  styledLayers,
  styleFilesAdded,
  symbologyTally,
  type ColorThemeState,
  type DatasetUpload
} from "../lib/colorTheme";
import { saveBlob } from "../lib/download";
import { cn } from "@/lib/utils";

type T = (english: string, japanese: string) => string;

type Mapping = { state: "loading" } | { state: "failed"; message: string } | { state: "loaded"; report: ColorThemeReport };

const formatCount = (value: number) => value.toLocaleString("en-US");

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function fieldWidth({ width, width_unit }: ColorThemeLayer, t: T): string {
  if (width_unit === "bytes") return t(`${width} bytes`, `${width} バイト`);
  return width === 0 ? t("no limit", "制限なし") : t(`${width} characters`, `${width} 文字`);
}

function skipDetail({ id, reason }: ColorThemeReport["skipped"][number], field: string, t: T): string {
  switch (reason) {
    case "field_not_text":
      return t(`${field} is not a text field; the file comes back untouched`, `${field} がテキスト型ではないため、そのまま戻します`);
    case "unreadable":
      return id.toLowerCase().endsWith(".gdb")
        ? t("The geodatabase could not be read safely; it comes back untouched", "ジオデータベースを安全に読めないため、そのまま戻します")
        : t("The table could not be read safely; the file comes back untouched", "テーブルを安全に読めないため、そのまま戻します");
    case "gdb_unavailable":
      return t(
        "This server has no Python with GDAL (ArcGIS Pro’s, or the one GDB_GDAL_PYTHON names), so the geodatabase cannot be edited; it comes back as uploaded",
        "このサーバーには GDAL を使える Python（ArcGIS Pro のもの、または GDB_GDAL_PYTHON で指定したもの）がないため、ジオデータベースを編集できず、アップロードしたまま戻します"
      );
  }
}

/** /color-theme: drop one station, check what changes, download the same files with color2 rewritten and its layers redrawn. */
export function ColorThemePage() {
  const { t } = useUiLanguage();
  const pushToast = useToast();
  const handleApiError = useApiErrorHandler();
  const [state, dispatch] = useReducer(colorThemeReducer, initialColorThemeState);
  const [mapping, setMapping] = useState<Mapping>({ state: "loading" });
  // Kept across stations: an operator who turns style files off means it for the next drop too.
  const [styleFiles, setStyleFiles] = useState(true);
  const inflight = useRef<AbortController | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetchColorTheme().then(
      (report) => active && setMapping({ state: "loaded", report }),
      (caught: unknown) => active && setMapping({ state: "failed", message: toErrorMessage(caught, "") })
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => inflight.current?.abort(), []);

  // React has no prop for it; the folder picker is what keeps the folder layout on a click-browse.
  useEffect(() => {
    if (folderInput.current) folderInput.current.webkitdirectory = true;
  }, []);

  /** Aborts whatever is in flight: one request at a time, and only the newest may answer. */
  const begin = () => {
    inflight.current?.abort();
    const request = new AbortController();
    inflight.current = request;
    return request.signal;
  };

  const inspect = (upload: DatasetUpload) => {
    if (upload.files.length === 0) return;
    const signal = begin();
    dispatch({ type: "dropped", upload });
    inspectColorTheme(upload.files, { signal, onProgress: (percent) => dispatch({ type: "progress", upload, percent }) }).then(
      (inspection) => dispatch({ type: "inspected", upload, inspection }),
      (caught: unknown) => {
        if (signal.aborted) return;
        const message = handleApiError(caught, t("Could not read the station", "駅のデータを読み込めませんでした"), {
          title: t("Check failed", "チェック失敗")
        });
        dispatch({ type: "inspectFailed", upload, message });
      }
    );
  };

  const download = async () => {
    if (state.phase !== "checked" || downloadBlockedReason(state.inspection, t, styleFiles)) return;
    const { upload } = state;
    const signal = begin();
    dispatch({ type: "convertStarted" });
    try {
      const { blob, filename } = await convertColorTheme(upload.files, {
        styleFiles,
        signal,
        onProgress: (percent) => dispatch({ type: "progress", upload, percent })
      });
      saveBlob(blob, filename);
      dispatch({ type: "converted", upload, filename });
      pushToast({
        title: t(`Created ${filename}`, `${filename} を作成しました`),
        description: t("It is in your browser’s downloads.", "ブラウザのダウンロードに保存されます。"),
        variant: "success"
      });
    } catch (caught) {
      if (signal.aborted) return;
      const message = handleApiError(caught, t("Could not build the download", "ダウンロードを作成できませんでした"), {
        title: t("Download failed", "ダウンロード失敗")
      });
      dispatch({ type: "convertFailed", upload, message });
    }
  };

  const reset = () => {
    inflight.current?.abort();
    dispatch({ type: "reset" });
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    // No accept filter: .sbn, .sbx, .shp.xml, .qmd, .idx and the rest must come back too.
    onDrop: (files) => inspect(datasetFiles(files)),
    multiple: true,
    noClick: true,
    noKeyboard: true
  });

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    inspect(datasetFiles(Array.from(event.target.files ?? [])));
    event.target.value = "";
  };

  const checked = state.phase === "checked" || state.phase === "converting" ? state : null;
  const inspection = checked?.inspection ?? null;
  const blocked = inspection ? downloadBlockedReason(inspection, t, styleFiles) : null;
  const lockFiles = checked ? checked.upload.lockFilesLeftOut + checked.inspection.dataset.lock_files_dropped : 0;

  usePageShell({
    current: colorThemeStage(state),
    station: inspection?.dataset.name ?? null,
    targets: inspection ? ["bring-in"] : [],
    go: { "bring-in": reset }
  });

  usePrimaryAction(
    inspection
      ? {
          label: t("Download", "ダウンロード"),
          run: () => void download(),
          disabledReason: blocked,
          busy: state.phase === "converting",
          anchor
        }
      : null
  );

  const pickers = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => folderInput.current?.click()}>
        <FolderOpen aria-hidden="true" />
        {t("Choose folder", "フォルダを選択")}
      </Button>
      <Button variant="outline" size="sm" onClick={() => zipInput.current?.click()}>
        <FileArchive aria-hidden="true" />
        {t("Choose file", "ファイルを選択")}
      </Button>
    </div>
  );

  const report = inspection?.theme ?? (mapping.state === "loaded" ? mapping.report : null);

  return (
    <div {...getRootProps({ className: "flex min-h-0 flex-1 flex-col" })}>
      <input {...getInputProps()} data-testid="color-theme-drop-input" />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="hidden"
        data-testid="color-theme-folder-input"
        onChange={picked}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip,.lyrx,.aprx"
        className="hidden"
        data-testid="color-theme-zip-input"
        onChange={picked}
      />

      <div className="flex flex-1 items-start gap-8 overflow-auto px-14 pb-6 pt-7">
        <main className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-[30px] font-semibold leading-tight text-foreground">
              {inspection
                ? t(`Recolour ${inspection.dataset.name}`, `${inspection.dataset.name} の色を新しくする`)
                : t("Recolour a station", "駅の色を新しくする")}
            </h1>
            <p className="max-w-[46rem] text-[15px] leading-[1.55] text-muted-foreground">
              {t(
                "Drop one station’s shapefile folder, its File Geodatabase (.gdb folder), its ArcGIS Pro layer files (.lyrx) or project (.aprx), or a zip of any of them. Each color2 value is rewritten to its new area name, as the table shows, and each layer coloured by color2 is redrawn in the new colours. A station with no color2 is coloured by category in its layer file or project, and those layers are redrawn by area.",
                "駅のシェープファイルのフォルダ、ファイルジオデータベース（.gdb フォルダ）、ArcGIS Pro のレイヤーファイル（.lyrx）やプロジェクト（.aprx）、またはそれらの zip をドロップしてください。color2 の値を表のとおり新しいエリア名に書き換え、color2 で色分けしたレイヤーを新しい色で描き直します。color2 のない駅はレイヤーファイルやプロジェクトで category により色分けされており、そのレイヤーをエリアごとに描き直します。"
              )}
            </p>
          </div>

          {inspection ? (
            <Summary inspection={inspection} pickers={pickers} styleFiles={styleFiles} />
          ) : (
            <DropArea state={state} dragging={isDragActive} pickers={pickers} />
          )}

          <section aria-labelledby="color-theme-table" className="flex flex-col gap-2.5">
            <MicroLabel id="color-theme-table">{t("Old colour → new area", "旧カラー → 新エリア")}</MicroLabel>
            {report ? (
              // Rows are counted only where the upload has a table to count them in, not for layer files alone.
              <RuleTable
                report={report}
                counted={inspection !== null && inspection.theme.layers.length + inspection.theme.skipped.length > 0}
              />
            ) : mapping.state === "failed" ? (
              <p role="alert" className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-destructive">
                {t("The colour table did not load.", "カラー表を読み込めませんでした。")} {mapping.message}
              </p>
            ) : (
              <SkeletonBlock className="h-[420px] w-full rounded-xl" />
            )}
          </section>

          {report ? <CategoryTable report={report} /> : null}

          {inspection && inspection.theme.layers.length > 0 ? <LayerTable layers={inspection.theme.layers} /> : null}
          {inspection && inspection.theme.symbology.length > 0 ? <Symbology report={inspection.theme} /> : null}
          {inspection && inspection.theme.style_files.length > 0 ? (
            <StyleFiles report={inspection.theme} wanted={styleFiles} onWanted={setStyleFiles} />
          ) : null}
        </main>

        <aside className="flex w-[360px] shrink-0 flex-col gap-4">
          {inspection ? <Attention inspection={inspection} /> : null}
          <WhatComesBack
            field={report?.field ?? "color2"}
            categoryField={report?.category_field ?? "category"}
            inspection={inspection}
            lockFiles={lockFiles}
          />
        </aside>
      </div>

      {inspection ? (
        <NextBar
          ref={anchor}
          step={nextStep(state, inspection, blocked, styleFiles, t)}
          progress={state.phase === "converting" ? state.progress : null}
          busyLabel={{ en: "Preparing…", ja: "準備中…" }}
          onGo={() => void download()}
          secondary={
            // Once delivered, the title names the file.
            state.phase === "checked" && state.delivered ? null : (
              <span className="max-w-[320px] truncate font-mono text-xs text-muted-foreground" title={inspection.dataset.download_name}>
                {inspection.dataset.download_name}
              </span>
            )
          }
        />
      ) : null}
    </div>
  );
}

function nextStep(state: ColorThemeState, inspection: ColorThemeInspection, blocked: string | null, styleFiles: boolean, t: T) {
  const { totals, layers } = inspection.theme;
  const changed = layers.filter((layer) => layer.counts.recolor > 0).length;
  const { rewritten } = symbologyTally(inspection.theme);
  const added = styleFiles ? styleFilesAdded(inspection.theme) : 0;
  const delivered = state.phase === "checked" ? state.delivered : null;
  const error = state.phase === "checked" ? state.error : null;
  const changes = [
    totals.recolor > 0
      ? t(
          `${plural(totals.recolor, "value changes", "values change")} in ${plural(changed, "layer", "layers")}`,
          `${formatCount(changed)} レイヤーの ${formatCount(totals.recolor)} 件の値を変更します`
        )
      : null,
    rewritten > 0
      ? t(`${plural(rewritten, "layer is", "layers are")} redrawn`, `${formatCount(rewritten)} レイヤーのシンボルを描き直します`)
      : null,
    added > 0
      ? t(`${plural(added, "style file is", "style files are")} added`, `スタイルファイル ${formatCount(added)} 個を追加します`)
      : null
  ].filter((part): part is string => part !== null);
  const title = blocked
    ? t("Nothing to change", "変更はありません")
    : delivered
      ? t(`Downloaded ${delivered}`, `${delivered} をダウンロードしました`)
      : changes.join(" · ");
  // GDAL rewrites a geodatabase's changed rows whole (Shape_Area recomputed), so only shapefiles get the stronger promise.
  const unchanged =
    inspection.dataset.geodatabases > 0
      ? t("Everything but the changed rows comes back as it was.", "変更する行以外はそのまま戻ります。")
      : t("Everything else comes back exactly as it was.", "ほかはすべてそのまま戻ります。");
  const detail = blocked ?? error ?? unchanged;
  const action = delivered ? t("Download again", "もう一度ダウンロード") : t("Download", "ダウンロード");
  // The strings are already in the operator's language.
  const same = (text: string) => ({ en: text, ja: text });
  return { title: same(title), detail: same(detail), action: same(action), blocked: blocked ? same(blocked) : null };
}

function MicroLabel({ id, children }: { id?: string; children: ReactNode }) {
  const { isJapanese } = useUiLanguage();
  return (
    <h2
      id={id}
      className={cn(
        "text-[11px] font-medium text-muted-foreground",
        // Geist Mono has no Japanese, so the small caps labels are sans there.
        !isJapanese && "font-mono uppercase tracking-[0.06em]"
      )}
    >
      {children}
    </h2>
  );
}

function DropArea({ state, dragging, pickers }: { state: ColorThemeState; dragging: boolean; pickers: ReactNode }) {
  const { t } = useUiLanguage();
  if (state.phase === "inspecting") {
    const count = state.upload.files.length;
    return (
      <div role="status" className="flex flex-col gap-3 rounded-[14px] border border-border bg-card px-6 py-6">
        <p className="text-sm font-medium text-foreground">
          {state.progress < 100
            ? t(`Sending ${plural(count, "file", "files")} · ${state.progress}%`, `${formatCount(count)} ファイルを送信中 · ${state.progress}%`)
            : t(`Checking ${plural(count, "file", "files")}…`, `${formatCount(count)} ファイルを確認中…`)}
        </p>
        <span aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <span className="block h-full bg-primary transition-all duration-300" style={{ width: `${state.progress}%` }} />
        </span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed px-6 py-9 text-center transition-colors",
        dragging ? "border-primary bg-accent" : "border-input bg-card"
      )}
    >
      <p className="text-sm font-medium text-foreground">
        {dragging
          ? t("Drop to check it", "ドロップして確認")
          : t(
              "Drop the station’s shapefile folder, .gdb folder, .lyrx, .aprx or zip here",
              "駅のシェープファイルのフォルダ、.gdb フォルダ、.lyrx、.aprx、または zip をここにドロップ"
            )}
      </p>
      <p className="text-[12.5px] text-muted-foreground">
        {t(
          "Every file comes back, whatever its kind, except stale lock files inside a .gdb.",
          "どの種類のファイルもすべて戻ります（.gdb 内の古いロックファイルを除く）。"
        )}
      </p>
      {pickers}
      {state.phase === "empty" && state.error ? (
        <p role="alert" className="rounded-md bg-destructive-muted px-3 py-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function Summary({
  inspection,
  pickers,
  styleFiles
}: {
  inspection: ColorThemeInspection;
  pickers: ReactNode;
  /** Whether the download is to carry style files. */
  styleFiles: boolean;
}) {
  const { t } = useUiLanguage();
  const { dataset, theme } = inspection;
  const added = styleFiles ? styleFilesAdded(theme) : 0;
  const styled = styledLayers(theme).filter((layer) => layer.added.length > 0).length;
  const leftAsIs = theme.totals.unmapped + theme.totals.too_wide + theme.totals.undecodable;
  const changedLayers = theme.layers.filter((layer) => layer.counts.recolor > 0).length;
  const symbology = symbologyTally(theme);
  const presence = fieldPresence(inspection);
  return (
    <section
      aria-label={t("What this station gets", "この駅の変更内容")}
      className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Stat label={t("Changes", "変更")} value={formatCount(theme.totals.recolor)} />
        <Stat label={t("Layers", "レイヤー")} value={formatCount(theme.layers.length)} />
        <Stat label={t("Left as is", "変更しない")} value={formatCount(leftAsIs)} warning={leftAsIs > 0} />
        {symbology.files > 0 ? <Stat label={t("Layers redrawn", "描き直すレイヤー")} value={formatCount(symbology.rewritten)} /> : null}
        {added > 0 ? <Stat label={t("Style files added", "追加するスタイルファイル")} value={formatCount(added)} /> : null}
        {/* One file per changed layer holds only for shapefiles: an edited feature class changes several and GDAL adds .freelist files. */}
        {dataset.geodatabases > 0 ? (
          <Stat label={t("Geodatabases", "ジオデータベース")} value={formatCount(dataset.geodatabases)} />
        ) : (
          <Stat
            label={t("Files back untouched", "そのまま戻るファイル")}
            value={`${formatCount(dataset.files - changedLayers - symbology.changedFiles)} / ${formatCount(dataset.files)}`}
          />
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <span className="text-xs text-muted-foreground">{t("Another station?", "別の駅？")}</span>
        {pickers}
      </div>
      {presence === "has_field" ? null : (
        <p className="flex basis-full items-start gap-2.5 border-t border-border pt-3.5 text-[13px] leading-[1.5] text-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
          {presence === "drawn_by_category"
            ? t(
                `No layer here has a ${theme.field} field. This station is coloured by ${theme.category_field} in its layer file or project, so drop its .lyrx or .aprx to recolour it.`,
                `${theme.field} フィールドのあるレイヤーがありません。この駅はレイヤーファイルまたはプロジェクトで ${theme.category_field} により色分けされているため、.lyrx か .aprx をドロップして色を新しくしてください。`
              )
            : t(
                `No layer here has a ${theme.field} field, so there is nothing to rewrite.`,
                `${theme.field} フィールドのあるレイヤーがないため、書き換えるものがありません。`
              )}
          {added > 0
            ? ` ${t(
                `The style files below still draw ${plural(styled, "polygon layer", "polygon layers")} in the new colours.`,
                `下のスタイルファイルを追加すれば、ポリゴンレイヤー ${formatCount(styled)} 件は新しい色で描かれます。`
              )}`
            : null}
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <Metric
      label={label}
      value={<span className={cn("text-lg tabular-nums", warning && "text-warning-foreground")}>{value}</span>}
    />
  );
}

function Swatch({ hex }: { hex: string | null }) {
  const { t } = useUiLanguage();
  return (
    <span
      title={hex ?? t("No fill", "塗りなし")}
      className={cn(
        "h-4 w-4 shrink-0 rounded-[3px] border",
        // A hairline, so a white swatch still reads on a white card; dashed where the old theme drew nothing.
        hex ? "border-foreground/25" : "border-dashed border-foreground/40"
      )}
      style={hex ? { backgroundColor: hex } : undefined}
    />
  );
}

function RuleTable({ report, counted }: { report: ColorThemeReport; counted: boolean }) {
  const { t, isJapanese } = useUiLanguage();
  const head = "px-3 py-2 text-left text-[11px] font-medium text-muted-foreground";
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">{t(`How ${report.field} changes`, `${report.field} の変更内容`)}</caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={head}>
              {t("Old", "旧")}
            </th>
            <th scope="col" className={head}>
              {t("Covered", "対象")}
            </th>
            <th scope="col" className={head}>
              <span className="sr-only">{t("becomes", "変更後")}</span>
            </th>
            <th scope="col" className={head}>
              {t(`New area, written to ${report.field}`, `新エリア（${report.field} に書く値）`)}
            </th>
            {counted ? (
              <th scope="col" className={cn(head, "text-right")}>
                {t("Rows", "件数")}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {report.rules.map((rule) => {
            const range = categoryRange(rule);
            return (
              <tr key={rule.rule} className={cn(counted && rule.rows === 0 && rule.too_wide === 0 && "opacity-50")}>
                <th scope="row" className="px-3 py-2.5 text-left font-medium text-foreground">
                  <span className="flex items-center gap-2.5">
                    <Swatch hex={rule.old_hex} />
                    <span className="whitespace-nowrap" title={rule.categories?.join(", ")}>
                      {rule.old}
                      {range ? <span className="font-mono text-[11px] font-normal text-muted-foreground"> · {range}</span> : null}
                    </span>
                  </span>
                </th>
                <td className="px-3 py-2.5 text-[12.5px] leading-[1.4] text-muted-foreground">
                  {t(rule.scope.en, rule.scope.ja)}
                </td>
                <td aria-hidden="true" className="px-1 py-2.5 text-muted-foreground">
                  →
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <Swatch hex={rule.hex} />
                    {/* Two lines of fixed height that never wrap, so every row is as tall as the next. */}
                    <span className="flex flex-col whitespace-nowrap">
                      <span className="font-medium leading-5 text-foreground">{rule.value}</span>
                      <span className="text-[11.5px] leading-4 text-muted-foreground">
                        {/* The value is the Japanese area name, so only English needs the name again. */}
                        {isJapanese ? null : `${rule.area_name.en} · `}
                        <span className="font-mono text-[10.5px]">{rule.spec}</span>
                      </span>
                    </span>
                  </span>
                </td>
                {counted ? (
                  <td className="px-3 py-2.5 text-right tabular-nums leading-5 text-foreground">
                    {formatCount(rule.rows)}
                    {rule.too_wide > 0 ? (
                      <span className="block whitespace-nowrap text-[11px] leading-4 text-warning-foreground">
                        {t(`${formatCount(rule.too_wide)} left as is`, `${formatCount(rule.too_wide)} 件そのまま`)}
                      </span>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The second mapping: which categories a layer coloured by category alone draws as which area. */
function CategoryTable({ report }: { report: ColorThemeReport }) {
  const { t, isJapanese } = useUiLanguage();
  const head = "px-3 py-2 text-left text-[11px] font-medium text-muted-foreground";
  return (
    <section aria-labelledby="color-theme-categories" className="flex flex-col gap-2.5">
      <MicroLabel id="color-theme-categories">
        {t(`No ${report.field}: ${report.category_field} → new area`, `${report.field} がない駅: ${report.category_field} → 新エリア`)}
      </MicroLabel>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">
            {t(`How layers coloured by ${report.category_field} are redrawn`, `${report.category_field} で色分けしたレイヤーの描き直し`)}
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={head}>
                {t("New area", "新エリア")}
              </th>
              <th scope="col" className={head}>
                {t(`Drawn for these ${report.category_field} values`, `この ${report.category_field} の値を描く`)}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {report.category_areas.map((line) => (
              <tr key={line.area}>
                <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
                  <span className="flex items-center gap-2.5">
                    <Swatch hex={line.hex} />
                    <span className="flex flex-col whitespace-nowrap">
                      <span className="font-medium leading-5 text-foreground">{line.value}</span>
                      <span className="text-[11.5px] leading-4 text-muted-foreground">
                        {isJapanese ? null : `${line.area_name.en} · `}
                        <span className="font-mono text-[10.5px]">{line.spec}</span>
                      </span>
                    </span>
                  </span>
                </th>
                <td className="px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-muted-foreground">
                  {line.categories.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Attention({ inspection }: { inspection: ColorThemeInspection }) {
  const { t } = useUiLanguage();
  const { field, unmapped, layers, skipped, symbology } = inspection.theme;
  const fileName = (id: string) => (
    <span className="font-mono text-xs" title={id}>
      {baseName(id)}
    </span>
  );
  const items: Array<{ key: string; title: ReactNode; detail: string; layers?: string[] }> = [
    ...unmapped.map((line) => ({
      key: `unmapped-${line.value}`,
      title: line.value,
      detail: t(
        `${plural(line.rows, "row", "rows")} in ${plural(line.layers.length, "layer", "layers")} · not in the table, left as is`,
        `${formatCount(line.rows)} 行・${formatCount(line.layers.length)} レイヤー · 表にない値のため変更しません`
      ),
      layers: line.layers
    })),
    ...layers
      .filter((layer) => layer.counts.too_wide > 0)
      .map((layer) => ({
        key: `too-wide-${layer.id}`,
        title: fileName(layer.id),
        detail: t(
          `${plural(layer.counts.too_wide, "row", "rows")} · the new value does not fit ${field} (${fieldWidth(layer, t)}), left as is`,
          `${formatCount(layer.counts.too_wide)} 行 · 新しい値が ${field}（${fieldWidth(layer, t)}）に収まらないため変更しません`
        )
      })),
    ...layers
      .filter((layer) => layer.counts.undecodable > 0)
      .map((layer) => ({
        key: `undecodable-${layer.id}`,
        title: fileName(layer.id),
        detail: t(
          `${plural(layer.counts.undecodable, "row", "rows")} could not be read as ${layer.encoding.codec}, left as is`,
          `${formatCount(layer.counts.undecodable)} 行を ${layer.encoding.codec} として読めないため変更しません`
        )
      })),
    ...skipped.map((layer) => ({
      key: `skipped-${layer.id}`,
      title: fileName(layer.id),
      detail: skipDetail(layer, field, t)
    })),
    ...symbology.flatMap((file) => [
      ...(file.unreadable
        ? [
            {
              key: `symbology-${file.path}`,
              title: fileName(file.path),
              detail: t("Could not be read as a layer file or project; it comes back untouched", "レイヤーファイルまたはプロジェクトとして読めないため、そのまま戻します")
            }
          ]
        : []),
      ...file.renderers
        .filter((renderer) => renderer.outcome === "left_alone")
        .map((renderer, index) => ({
          key: `renderer-${file.path}-${index}`,
          title: <span className="font-mono text-xs">{renderer.layer ?? baseName(file.path)}</span>,
          detail: `${baseName(file.path)} · ${leftAloneDetail(renderer.reason, renderer.field ?? field, t)}`
        }))
    ]),
    ...keptGroups(inspection.theme).map((group, index) => ({
      key: `kept-${group.path}-${index}`,
      title:
        group.layers.length === 1 ? (
          <span className="font-mono text-xs">{group.layers[0] ?? baseName(group.path)}</span>
        ) : (
          t(plural(group.layers.length, "layer", "layers"), `${formatCount(group.layers.length)} レイヤー`)
        ),
      detail:
        group.layers.length === 1
          ? t(
              `${baseName(group.path)} · not in the table, kept in its old class: ${group.kept.join(", ")}`,
              `${baseName(group.path)} · 表にない値のため元のクラスのまま: ${group.kept.join("、")}`
            )
          : t(
              `${baseName(group.path)} · not in the table, kept in their old classes: ${group.kept.join(", ")}`,
              `${baseName(group.path)} · 表にない値のため元のクラスのまま: ${group.kept.join("、")}`
            )
    }))
  ];

  return (
    <section aria-labelledby="color-theme-attention" className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
      <h2 id="color-theme-attention" className="font-display text-xl font-semibold text-foreground">
        {items.length > 0 ? t("Needs attention", "要確認") : t("Nothing needs attention", "確認が必要なものはありません")}
      </h2>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key} className="flex gap-2.5">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-semibold text-foreground">{item.title}</span>
                <span className="text-[12.5px] leading-[1.45] text-muted-foreground">{item.detail}</span>
                {item.layers ? (
                  <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-muted-foreground">
                    {item.layers.map((layer) => (
                      <span key={layer} className="whitespace-nowrap" title={layer}>
                        {baseName(layer)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-start gap-2 text-[12.5px] leading-[1.45] text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-primary" />
          {t(
            "Every value is in the table, already new or blank, and every new value fits its field.",
            "すべての値が表にあるか、すでに新しいか空欄で、新しい値はすべてフィールドに収まります。"
          )}
        </p>
      )}
    </section>
  );
}

type ReturnedFormats = {
  shapefile: boolean;
  /** Shapefiles a style file can go beside. */
  styleFiles: boolean;
  geodatabase: boolean;
  /** Layer files or projects with layers coloured by the colour field, or with none the tool takes up. */
  symbology: boolean;
  /** Layer files or projects with a layer coloured by the category field. */
  categorySymbology: boolean;
};

/** Which formats the download holds, so each promise is made only where it is true. All until an upload says. */
function returnedFormats(inspection: ColorThemeInspection | null): ReturnedFormats {
  if (!inspection) return { shapefile: true, styleFiles: true, geodatabase: true, symbology: true, categorySymbology: true };
  const { dataset, theme } = inspection;
  const renderers = theme.symbology.flatMap((file) => file.renderers);
  const byCategory = renderers.some((renderer) => renderer.field === theme.category_field);
  return {
    shapefile:
      (dataset.geodatabases === 0 && theme.symbology.length === 0) ||
      [...theme.layers, ...theme.skipped].some(({ id }) => !inGeodatabase(id)),
    styleFiles: theme.style_files.length > 0,
    geodatabase: dataset.geodatabases > 0,
    symbology: theme.symbology.length > 0 && (!byCategory || renderers.some((renderer) => renderer.field !== theme.category_field)),
    categorySymbology: byCategory
  };
}

function WhatComesBack({
  field,
  categoryField,
  inspection,
  lockFiles
}: {
  field: string;
  categoryField: string;
  inspection: ColorThemeInspection | null;
  /** Left out by the page before sending and by the server from a zip, together. */
  lockFiles: number;
}) {
  const { t } = useUiLanguage();
  const formats = returnedFormats(inspection);
  const paragraph = "text-[12.5px] leading-[1.5] text-muted-foreground";
  return (
    <section aria-labelledby="color-theme-returns" className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-5">
      <h2 id="color-theme-returns" className="font-display text-xl font-semibold text-foreground">
        {t("What comes back", "戻ってくるもの")}
      </h2>
      {formats.shapefile ? (
        <p className={paragraph}>
          {t(
            `Shapefiles come back as the same files in the same folders, in one zip. Only ${field} changes. Geometry, every other field, .prj, .cpg and the indexes come back byte for byte.`,
            `シェープファイルは同じフォルダ構成の同じファイルとして 1 つの zip で戻ります。変わるのは ${field} だけです。ジオメトリ、ほかのフィールド、.prj、.cpg、インデックスはそのまま戻ります。`
          )}
        </p>
      ) : null}
      {formats.styleFiles ? (
        <p className={paragraph}>
          {t(
            `With style files on, each polygon shapefile that has ${field}, or a ${categoryField} in the second table, also gets a .qml for QGIS and a .lyrx for ArcGIS Pro: one class per new area, and grey for any other value. QGIS loads the .qml with the shapefile by itself. ArcGIS Pro drawing the .lyrx has not been verified. A geodatabase gets none.`,
            `スタイルファイルを追加する場合、${field} か 2 つ目の表にある ${categoryField} を持つポリゴンのシェープファイルごとに、QGIS 用の .qml と ArcGIS Pro 用の .lyrx が付きます。新エリアごとに 1 クラスで、ほかの値はグレーで描きます。QGIS はシェープファイルと一緒に .qml を自動で読み込みます。ArcGIS Pro で .lyrx が正しく描かれるかは未確認です。ジオデータベースには付きません。`
          )}
        </p>
      ) : null}
      {formats.geodatabase ? (
        <p className={paragraph}>
          {t(
            "In a geodatabase, GDAL rewrites each changed row. Other tables, fields and indexes stay as they were; Shape_Area and Shape_Length are recomputed. Convert a copy and open it in ArcGIS Pro before replacing the original.",
            "ジオデータベースでは、変更する行を GDAL が書き直します。ほかのテーブル、フィールド、インデックスはそのままですが、Shape_Area と Shape_Length は再計算されます。元のデータを置き換える前に、コピーを変換して ArcGIS Pro で開いて確認してください。"
          )}
        </p>
      ) : null}
      {formats.symbology ? (
        <p className={paragraph}>
          {t(
            `Layer files (.lyrx) and projects (.aprx) come back with each layer coloured by ${field} redrawn: one class per new area, in its new fill, outlined in TurquoiseGray 1000. Each class also lists the old colours, so data not yet converted draws the same. Everything else in them stays as it was. One exception: an old 濃鼠 toilet (B007–B014) draws white until its data is converted.`,
            `レイヤーファイル（.lyrx）とプロジェクト（.aprx）は、${field} で色分けした各レイヤーを描き直して戻ります。新エリアごとに 1 クラス、新しい塗りと TurquoiseGray 1000 の枠線です。各クラスは旧カラーも含むため、変換前のデータも同じ色で描かれます。ほかはそのままです。例外として、旧 濃鼠 のトイレ（B007–B014）はデータを変換するまで白で描かれます。`
          )}
        </p>
      ) : null}
      {formats.categorySymbology ? (
        <p className={paragraph}>
          {t(
            `A layer coloured by ${categoryField} alone, in a station with no ${field}, is redrawn too: one class per new area its categories belong to, in the same fills and outline. Its data is not changed. A category that is not in the table keeps its own class and colour.`,
            `${field} のない駅で ${categoryField} だけで色分けしたレイヤーも描き直します。カテゴリが属する新エリアごとに 1 クラス、同じ塗りと枠線です。データは変更しません。表にないカテゴリは元のクラスと色のままです。`
          )}
        </p>
      ) : null}
      <p className={paragraph}>
        {t(
          "Values that are already new, blank, or not in the table are left as they are.",
          "すでに新しい値、空欄、表にない値は変更しません。"
        )}
      </p>
      {lockFiles > 0 ? (
        <p className={paragraph}>
          {t(
            `Left out: ${plural(lockFiles, "stale geodatabase lock file", "stale geodatabase lock files")}.`,
            `ジオデータベース内の古いロックファイル ${formatCount(lockFiles)} 個は含めません。`
          )}
        </p>
      ) : null}
    </section>
  );
}

const SOURCE_LABEL: Record<ColorThemeLayer["encoding"]["source"], { en: string; ja: string }> = {
  cpg: { en: ".cpg", ja: ".cpg" },
  ldid: { en: "language driver", ja: "言語ドライバー" },
  sniffed: { en: "guessed", ja: "推定" },
  ascii: { en: "ASCII only", ja: "ASCII のみ" },
  gdb: { en: "geodatabase", ja: "ジオデータベース" }
};

function LayerTable({ layers }: { layers: ColorThemeLayer[] }) {
  const { t } = useUiLanguage();
  const head = "px-3 py-2 text-left text-[11px] font-medium text-muted-foreground";
  return (
    <details className="group flex flex-col gap-2.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        {t(`Layers (${layers.length})`, `レイヤー（${layers.length}）`)}
      </summary>
      <div className="mt-2.5 overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={head}>
                {t("Path", "パス")}
              </th>
              <th scope="col" className={head}>
                {t("Encoding", "文字コード")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("Width", "幅")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("Changes", "変更")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("Left as is", "変更しない")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {layers.map((layer) => {
              const source = SOURCE_LABEL[layer.encoding.source];
              const leftAsIs = layer.counts.unmapped + layer.counts.too_wide + layer.counts.undecodable;
              return (
                <tr key={layer.id}>
                  <td className="break-all px-3 py-2 font-mono text-[11.5px] text-foreground">{layer.id}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    <span className="font-mono">{layer.encoding.codec}</span> · {t(source.en, source.ja)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {fieldWidth(layer, t)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{formatCount(layer.counts.recolor)}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", leftAsIs > 0 ? "text-warning-foreground" : "text-foreground")}>
                    {formatCount(leftAsIs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function leftAloneDetail(reason: ColorThemeRenderer["reason"], field: string, t: T): string {
  switch (reason) {
    case "several_fields":
      return t(`Coloured by ${field} and other fields; left as it is`, `${field} とほかのフィールドで色分けしているため、そのままにします`);
    case "expression":
      return t(`Coloured by an Arcade expression on ${field}; left as it is`, `${field} の Arcade 式で色分けしているため、そのままにします`);
    case "not_polygon":
      return t("Not drawn with polygon symbols; left as it is", "ポリゴンシンボルではないため、そのままにします");
    case "no_known_values":
      return t("No class is an old or new colour; left as it is", "旧カラーにも新しい色にも一致するクラスがないため、そのままにします");
    case "unreadable":
      return t("This part of the project could not be read; it comes back untouched", "プロジェクトのこの部分を読めないため、そのまま戻します");
    case "unrecognised":
    case null:
      return t("Its classes are in a form this tool does not rewrite; left as it is", "クラスの形式を書き換えられないため、そのままにします");
  }
}

function Symbology({ report }: { report: ColorThemeReport }) {
  const { t } = useUiLanguage();
  const areas = new Map(report.rules.map((rule) => [rule.area, rule]));
  const head = "px-3 py-2 text-left text-[11px] font-medium text-muted-foreground";
  return (
    <section aria-labelledby="color-theme-symbology" className="flex flex-col gap-2.5">
      <MicroLabel id="color-theme-symbology">{t("Symbology", "シンボル")}</MicroLabel>
      {report.symbology.map((file) => {
        const redrawn = file.renderers.filter((renderer) => renderer.outcome === "rewritten").length;
        const leftAlone = file.renderers.filter((renderer) => renderer.outcome === "left_alone").length;
        const note = file.unreadable
          ? t("Could not be read; it comes back untouched.", "読み込めないため、そのまま戻します。")
          : file.renderers.length === 0
            ? t(
                `No layer here is coloured by ${report.field}, or by a ${report.category_field} in the table; it comes back untouched.`,
                `${report.field} で色分けしたレイヤーも、表にある ${report.category_field} で色分けしたレイヤーもないため、そのまま戻します。`
              )
            : null;
        return (
          <div key={file.path} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3">
              <span className="flex min-w-0 items-baseline gap-2.5">
                <span className="break-all font-mono text-[12px] font-medium text-foreground">{file.path}</span>
                <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">
                  {file.kind === "aprx" ? t("Project", "プロジェクト") : t("Layer file", "レイヤーファイル")}
                </span>
              </span>
              {file.renderers.length > 0 ? (
                <span className="whitespace-nowrap text-[12px] tabular-nums text-muted-foreground">
                  {t(`${formatCount(redrawn)} redrawn`, `${formatCount(redrawn)} 件描き直し`)}
                  {leftAlone > 0 ? (
                    <span className="text-warning-foreground">
                      {" · "}
                      {t(`${formatCount(leftAlone)} left as is`, `${formatCount(leftAlone)} 件そのまま`)}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            {note ? <p className="border-t border-border px-4 py-2.5 text-[12.5px] text-muted-foreground">{note}</p> : null}
            {file.kind === "aprx" && !file.unreadable ? (
              <p className="border-t border-border px-4 py-2.5 text-[12.5px] leading-[1.45] text-muted-foreground">
                {t(
                  "Esri does not document editing a project outside ArcGIS Pro. Keep the original, and open the new copy in Pro before you use it.",
                  "ArcGIS Pro の外でのプロジェクト編集は Esri が文書化していません。元のファイルを残し、新しいコピーを Pro で開いて確認してから使ってください。"
                )}
              </p>
            ) : null}
            {file.renderers.length > 0 ? (
              <details className="group border-t border-border" open={file.renderers.length <= 8}>
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                  {t(`Layers (${file.renderers.length})`, `レイヤー（${file.renderers.length}）`)}
                </summary>
                <table className="w-full border-collapse text-[12.5px]">
                  <thead className="border-y border-border">
                    <tr>
                      <th scope="col" className={head}>
                        {t("Layer", "レイヤー")}
                      </th>
                      <th scope="col" className={head}>
                        {t("Coloured by", "色分け")}
                      </th>
                      <th scope="col" className={cn(head, "text-right")}>
                        {t("Classes", "クラス")}
                      </th>
                      <th scope="col" className={head}>
                        {t("Draws", "描く色")}
                      </th>
                      <th scope="col" className={head}>
                        {t("Result", "結果")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {file.renderers.map((renderer, index) => (
                      <tr key={`${renderer.layer}-${index}`}>
                        <td className="break-all px-3 py-2 font-mono text-[11.5px] text-foreground">{renderer.layer ?? "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
                          {renderer.field ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {renderer.outcome === "rewritten"
                            ? `${renderer.classes_before} → ${renderer.classes_after}`
                            : formatCount(renderer.classes_after)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex gap-1">
                            {renderer.areas.map((key) => {
                              const area = areas.get(key);
                              return area ? (
                                <span key={key} className="flex" title={`${area.value} · ${area.spec}`}>
                                  <Swatch hex={area.hex} />
                                </span>
                              ) : null;
                            })}
                          </span>
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-[12px]",
                            renderer.outcome === "left_alone" ? "text-warning-foreground" : "text-muted-foreground"
                          )}
                        >
                          {renderer.outcome === "rewritten"
                            ? t("Redrawn", "描き直し")
                            : renderer.outcome === "already_new"
                              ? t("Already new", "すでに新しい色")
                              : leftAloneDetail(renderer.reason, renderer.field ?? report.field, t)}
                          {renderer.kept.length > 0 ? (
                            <span className="block text-warning-foreground">
                              {t(`Kept as it was: ${renderer.kept.join(", ")}`, `そのまま: ${renderer.kept.join("、")}`)}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

const STYLE_KIND: Record<ColorThemeStyleFile["kind"], string> = { qml: ".qml", lyrx: ".lyrx" };

/** The option, and the layers it covers: which shapefiles get a .qml and a .lyrx, and what each is coloured by. */
function StyleFiles({
  report,
  wanted,
  onWanted
}: {
  report: ColorThemeReport;
  wanted: boolean;
  onWanted: (wanted: boolean) => void;
}) {
  const { t } = useUiLanguage();
  const areas = new Map(report.rules.map((rule) => [rule.area, rule]));
  const layers = styledLayers(report);
  const added = styleFilesAdded(report);
  const head = "px-3 py-2 text-left text-[11px] font-medium text-muted-foreground";
  return (
    <section aria-labelledby="color-theme-style-files" className="flex flex-col gap-2.5">
      <MicroLabel id="color-theme-style-files">{t("Style files", "スタイルファイル")}</MicroLabel>
      <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
          <Checkbox
            className="mt-0.5"
            checked={wanted}
            disabled={added === 0}
            onCheckedChange={(next) => onWanted(next === true)}
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-[13px] font-medium text-foreground">
              {t("Add style files for QGIS and ArcGIS Pro", "QGIS と ArcGIS Pro 用のスタイルファイルを追加")}
            </span>
            <span className="text-[12.5px] leading-[1.45] text-muted-foreground">
              {added > 0
                ? t(
                    `${plural(added, "file", "files")} beside ${plural(layers.filter((layer) => layer.added.length > 0).length, "polygon layer", "polygon layers")}, so the shapefiles open in the new colours. QGIS loads a .qml with its shapefile by itself. ArcGIS Pro drawing the .lyrx has not been verified, so open one in Pro before you rely on it.`,
                    `ポリゴンレイヤー ${formatCount(layers.filter((layer) => layer.added.length > 0).length)} 件の横に ${formatCount(added)} ファイルを追加し、シェープファイルを新しい色で開けるようにします。QGIS は .qml をシェープファイルと一緒に自動で読み込みます。ArcGIS Pro で .lyrx が正しく描かれるかは未確認のため、使う前に Pro で開いて確認してください。`
                  )
                : t(
                    "Every layer here already has both style files, so there is none to add.",
                    "どのレイヤーにもスタイルファイルがすでにあるため、追加するものはありません。"
                  )}
            </span>
          </span>
        </label>
        <details className="group border-t border-border" open={layers.length <= 8}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {t(`Layers (${layers.length})`, `レイヤー（${layers.length}）`)}
          </summary>
          <table className={cn("w-full border-collapse text-[12.5px]", !wanted && "opacity-50")}>
            <thead className="border-y border-border">
              <tr>
                <th scope="col" className={head}>
                  {t("Shapefile", "シェープファイル")}
                </th>
                <th scope="col" className={head}>
                  {t("Coloured by", "色分け")}
                </th>
                <th scope="col" className={head}>
                  {t("Draws", "描く色")}
                </th>
                <th scope="col" className={head}>
                  {t("Added", "追加")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {layers.map((layer) => (
                <tr key={layer.layer}>
                  <td className="break-all px-3 py-2 font-mono text-[11.5px] text-foreground">{layer.layer}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{layer.field}</td>
                  <td className="px-3 py-2">
                    <span className="flex gap-1">
                      {layer.classes.map((key) => {
                        const area = areas.get(key);
                        return area ? (
                          <span key={key} className="flex" title={`${area.value} · ${area.spec}`}>
                            <Swatch hex={area.hex} />
                          </span>
                        ) : null;
                      })}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">
                    <span className="font-mono text-[11.5px]">
                      {layer.added.length > 0 ? layer.added.map((file) => STYLE_KIND[file.kind]).join(" · ") : "—"}
                    </span>
                    {layer.kept.length > 0 ? (
                      <span className="block text-warning-foreground">
                        {t(
                          `Already here, kept as it is: ${layer.kept.map((file) => baseName(file.path)).join(", ")}`,
                          `すでにあるためそのまま: ${layer.kept.map((file) => baseName(file.path)).join("、")}`
                        )}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </section>
  );
}
