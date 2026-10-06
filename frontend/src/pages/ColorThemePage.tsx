import { AlertTriangle, CheckCircle2, ChevronRight, FileArchive, FolderOpen } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useDropzone } from "react-dropzone";

import {
  convertColorTheme,
  fetchColorTheme,
  inspectColorTheme,
  type ColorThemeInspection,
  type ColorThemeLayer,
  type ColorThemeReport,
  type DatasetFile
} from "../api/client";
import { toErrorMessage } from "../api/errors";
import { NextBar } from "../components/bringIn/NextBar";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast } from "../components/shared/ToastProvider";
import { usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { Button, Metric } from "../components/ui";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  categoryRange,
  colorThemeReducer,
  colorThemeStage,
  datasetFiles,
  downloadBlockedReason,
  inGeodatabase,
  initialColorThemeState,
  type ColorThemeState
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

/** /color-theme: drop one station, check what changes, download the same files with color2 rewritten. */
export function ColorThemePage() {
  const { t } = useUiLanguage();
  const pushToast = useToast();
  const handleApiError = useApiErrorHandler();
  const [state, dispatch] = useReducer(colorThemeReducer, initialColorThemeState);
  const [mapping, setMapping] = useState<Mapping>({ state: "loading" });
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

  const inspect = (files: DatasetFile[]) => {
    if (files.length === 0) return;
    const signal = begin();
    dispatch({ type: "dropped", files });
    inspectColorTheme(files, { signal, onProgress: (percent) => dispatch({ type: "progress", files, percent }) }).then(
      (inspection) => dispatch({ type: "inspected", files, inspection }),
      (caught: unknown) => {
        if (signal.aborted) return;
        const message = handleApiError(caught, t("Could not read the station", "駅のデータを読み込めませんでした"), {
          title: t("Check failed", "チェック失敗")
        });
        dispatch({ type: "inspectFailed", files, message });
      }
    );
  };

  const download = async () => {
    if (state.phase !== "checked" || downloadBlockedReason(state.inspection, t)) return;
    const { files } = state;
    const signal = begin();
    dispatch({ type: "convertStarted" });
    try {
      const { blob, filename } = await convertColorTheme(files, {
        signal,
        onProgress: (percent) => dispatch({ type: "progress", files, percent })
      });
      saveBlob(blob, filename);
      dispatch({ type: "converted", files, filename });
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
      dispatch({ type: "convertFailed", files, message });
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

  const inspection = state.phase === "checked" || state.phase === "converting" ? state.inspection : null;
  const blocked = inspection ? downloadBlockedReason(inspection, t) : null;

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
        {t("Choose zip", "zip を選択")}
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
      <input ref={zipInput} type="file" accept=".zip" className="hidden" data-testid="color-theme-zip-input" onChange={picked} />

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
                "Drop one station’s shapefile folder, its File Geodatabase (.gdb folder), or a zip of either. Each color2 value is rewritten to its new area name, as the table shows.",
                "駅のシェープファイルのフォルダ、ファイルジオデータベース（.gdb フォルダ）、またはそのどちらかの zip をドロップしてください。color2 の値を表のとおり新しいエリア名に書き換えます。"
              )}
            </p>
          </div>

          {inspection ? (
            <Summary inspection={inspection} pickers={pickers} />
          ) : (
            <DropArea state={state} dragging={isDragActive} pickers={pickers} />
          )}

          <section aria-labelledby="color-theme-table" className="flex flex-col gap-2.5">
            <MicroLabel id="color-theme-table">{t("Old colour → new area", "旧カラー → 新エリア")}</MicroLabel>
            {report ? (
              <RuleTable report={report} counted={inspection !== null} />
            ) : mapping.state === "failed" ? (
              <p role="alert" className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-destructive">
                {t("The colour table did not load.", "カラー表を読み込めませんでした。")} {mapping.message}
              </p>
            ) : (
              <SkeletonBlock className="h-[420px] w-full rounded-xl" />
            )}
          </section>

          {inspection ? <LayerTable layers={inspection.theme.layers} /> : null}
        </main>

        <aside className="flex w-[360px] shrink-0 flex-col gap-4">
          {inspection ? <Attention inspection={inspection} /> : null}
          <WhatComesBack field={report?.field ?? "color2"} inspection={inspection} />
        </aside>
      </div>

      {inspection ? (
        <NextBar
          ref={anchor}
          step={nextStep(state, inspection, blocked, t)}
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

function nextStep(state: ColorThemeState, inspection: ColorThemeInspection, blocked: string | null, t: T) {
  const { totals, layers } = inspection.theme;
  const changed = layers.filter((layer) => layer.counts.recolor > 0).length;
  const delivered = state.phase === "checked" ? state.delivered : null;
  const error = state.phase === "checked" ? state.error : null;
  const title = blocked
    ? t("Nothing to change", "変更はありません")
    : delivered
      ? t(`Downloaded ${delivered}`, `${delivered} をダウンロードしました`)
      : t(
          `${plural(totals.recolor, "value changes", "values change")} in ${plural(changed, "layer", "layers")}`,
          `${formatCount(changed)} レイヤーの ${formatCount(totals.recolor)} 件の値を変更します`
        );
  const detail = blocked ?? error ?? t("Everything else comes back exactly as it was.", "ほかはすべてそのまま戻ります。");
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
    const count = state.files.length;
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
          : t("Drop the station’s shapefile folder, .gdb folder or zip here", "駅のシェープファイルのフォルダ、.gdb フォルダ、または zip をここにドロップ")}
      </p>
      <p className="text-[12.5px] text-muted-foreground">
        {t("Every file comes back, whatever its kind.", "どの種類のファイルもすべて戻ります。")}
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

function Summary({ inspection, pickers }: { inspection: ColorThemeInspection; pickers: ReactNode }) {
  const { t } = useUiLanguage();
  const { dataset, theme } = inspection;
  const leftAsIs = theme.totals.unmapped + theme.totals.too_wide + theme.totals.undecodable;
  const changedLayers = theme.layers.filter((layer) => layer.counts.recolor > 0).length;
  return (
    <section
      aria-label={t("What this station gets", "この駅の変更内容")}
      className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Stat label={t("Changes", "変更")} value={formatCount(theme.totals.recolor)} />
        <Stat label={t("Layers", "レイヤー")} value={formatCount(theme.layers.length)} />
        <Stat label={t("Left as is", "変更しない")} value={formatCount(leftAsIs)} warning={leftAsIs > 0} />
        {/* One file per changed layer holds only for shapefiles: an edited feature class changes several and GDAL adds .freelist files. */}
        {dataset.geodatabases > 0 ? (
          <Stat label={t("Geodatabases", "ジオデータベース")} value={formatCount(dataset.geodatabases)} />
        ) : (
          <Stat
            label={t("Files back untouched", "そのまま戻るファイル")}
            value={`${formatCount(dataset.files - changedLayers)} / ${formatCount(dataset.files)}`}
          />
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <span className="text-xs text-muted-foreground">{t("Another station?", "別の駅？")}</span>
        {pickers}
      </div>
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

function Attention({ inspection }: { inspection: ColorThemeInspection }) {
  const { t } = useUiLanguage();
  const { field, unmapped, layers, skipped } = inspection.theme;
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

/** Which formats the download holds, so each promise is made only where it is true. Both until an upload says. */
function returnedFormats(inspection: ColorThemeInspection | null): { shapefile: boolean; geodatabase: boolean } {
  if (!inspection) return { shapefile: true, geodatabase: true };
  const { dataset, theme } = inspection;
  return {
    shapefile: dataset.geodatabases === 0 || [...theme.layers, ...theme.skipped].some(({ id }) => !inGeodatabase(id)),
    geodatabase: dataset.geodatabases > 0
  };
}

function WhatComesBack({ field, inspection }: { field: string; inspection: ColorThemeInspection | null }) {
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
      {formats.geodatabase ? (
        <p className={paragraph}>
          {t(
            "In a geodatabase, GDAL rewrites each changed row. Other tables, fields and indexes stay as they were; Shape_Area and Shape_Length are recomputed. Convert a copy and open it in ArcGIS Pro before replacing the original.",
            "ジオデータベースでは、変更する行を GDAL が書き直します。ほかのテーブル、フィールド、インデックスはそのままですが、Shape_Area と Shape_Length は再計算されます。元のデータを置き換える前に、コピーを変換して ArcGIS Pro で開いて確認してください。"
          )}
        </p>
      ) : null}
      <p className={paragraph}>
        {t(
          "Values that are already new, blank, or not in the table are left as they are.",
          "すでに新しい値、空欄、表にない値は変更しません。"
        )}
      </p>
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
