import { AlertTriangle, ChevronRight, CheckCircle2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import {
  exportSessionArchive,
  exportSessionQgisProject,
  exportSessionShapefiles,
  fetchExportContents,
  fetchHandover,
  fetchStoredValidation,
  validateSession,
  type ExportContents,
  type ExportFormat,
  type HandoverNote as StoredNote,
  type ShapefileExportEncoding,
  type ShapefileExportRequest,
  type ValidationSummary
} from "../api/client";
import { NextBar } from "../components/bringIn/NextBar";
import { HandoverNote } from "../components/handover/HandoverNote";
import { useToast } from "../components/shared/ToastProvider";
import { usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { projectPath, stationName } from "../components/shell/stages";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from "../components/ui";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  buildDeliverView,
  defaultSelection,
  defaultShapefileOptions,
  shapefileRequest,
  type OutputCard,
  type ShapefileOptions,
  type Tone
} from "../lib/deliver";
import { useAppStore } from "../store/useAppStore";
import { cn } from "@/lib/utils";

function download(format: ExportFormat, sessionId: string, request: ShapefileExportRequest | null) {
  if (format === "qgis_project") return exportSessionQgisProject(sessionId, request!);
  if (format === "shapefiles" || format === "odc2026_shapefiles") return exportSessionShapefiles(sessionId, request!);
  return exportSessionArchive(sessionId, format === "imdf_zip");
}

function saveBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

const TONE_ICON: Record<Tone, ReactNode> = {
  ok: <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />,
  wait: (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-warning text-[10px] font-bold text-card"
    >
      !
    </span>
  ),
  danger: <X aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />,
  stale: <RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
};

export function DeliverPage() {
  const navigate = useNavigate();
  const sessionId = useAppStore((state) => state.sessionId) ?? "";
  const importProfile = useAppStore((state) => state.importProfile);
  const files = useAppStore((state) => state.files);
  const wizardState = useAppStore((state) => state.wizardState);
  const handleApiError = useApiErrorHandler(sessionId);
  const pushToast = useToast();
  const { t, isJapanese } = useUiLanguage();
  // Geist Mono has no Japanese, so the small caps labels are sans there.
  const label = cn("text-[11px] font-medium", !isJapanese && "font-mono uppercase tracking-[0.06em]");

  const geoPackage = files.some((file) => file.source_format === "gpkg");
  const [selected, setSelected] = useState(() => defaultSelection(importProfile, geoPackage));
  const [options, setOptions] = useState<ShapefileOptions>(() => defaultShapefileOptions(wizardState));
  const [checks, setChecks] = useState<ValidationSummary | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [contents, setContents] = useState<ExportContents[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [created, setCreated] = useState<ReadonlySet<ExportFormat>>(() => new Set());
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetchStoredValidation(sessionId).then(
      (stored) => active && setChecks(stored?.summary ?? null),
      (caught: unknown) => {
        if (!active) return;
        setChecks(null);
        handleApiError(caught, t("Could not read the checks", "チェック結果を読み込めませんでした"));
      }
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  // The prefix names the ODC files, so the listing follows it once typing pauses.
  useEffect(() => {
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      fetchExportContents(sessionId, options.prefix.trim(), options.encoding, request.signal).then(
        (listed) => setContents(listed),
        (caught: unknown) => {
          if (!request.signal.aborted)
            handleApiError(caught, t("Could not list the files", "ファイル一覧を取得できませんでした"));
        }
      );
    }, 400);
    return () => {
      request.abort();
      window.clearTimeout(timer);
    };
  }, [sessionId, options.prefix, options.encoding]);

  const view = useMemo(
    () =>
      buildDeliverView({
        selected,
        contents,
        checks: checks ?? null,
        checking: checking || checks === undefined,
        geoPackage,
        options,
        stems: files.map((file) => file.stem)
      }),
    [selected, contents, checks, checking, geoPackage, options, files]
  );
  const station = stationName(wizardState, files) ?? "";
  const [note, setNote] = useState<{ loaded: boolean; note: StoredNote | null }>({ loaded: false, note: null });

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    fetchHandover(sessionId).then(
      (handover) => active && setNote({ loaded: true, note: handover.note }),
      () => active && setNote({ loaded: true, note: null })
    );
    return () => {
      active = false;
    };
  }, [sessionId]);
  const busy = progress !== null;

  const checkAgain = async () => {
    setChecking(true);
    try {
      setChecks((await validateSession(sessionId)).summary);
    } catch (caught) {
      handleApiError(caught, t("Validation failed", "検証に失敗しました"), {
        title: t("Check failed", "チェック失敗")
      });
    } finally {
      setChecking(false);
    }
  };

  // Each output is its own download. After the first, a browser may ask
  // before saving more, so the toast says what was created, not what landed,
  // and each created card offers its file again.
  const create = async (formats: ReadonlyArray<ExportFormat> = view.toCreate) => {
    if (busy || formats.length === 0) return;
    const made: string[] = [];
    setProgress(0);
    try {
      for (const format of formats) {
        const prepared = shapefileRequest(format, options);
        if ("error" in prepared) return;
        const response = await download(format, sessionId, prepared.request);
        saveBlob(response.blob, response.filename);
        made.push(response.filename);
        setCreated((current) => new Set(current).add(format));
        setProgress(Math.round((made.length / formats.length) * 100));
      }
      pushToast({
        title:
          made.length === 1
            ? t(`Created ${made[0]}`, `${made[0]} を作成しました`)
            : t(`Created ${made.length} files`, `${made.length} 個のファイルを作成しました`),
        description:
          made.length === 1
            ? t("It is in your browser’s downloads.", "ブラウザのダウンロードに保存されます。")
            : t(
                "If your browser asked, allow multiple downloads. Any file that didn’t arrive can be downloaded again from its card.",
                "ブラウザに確認された場合は、複数のダウンロードを許可してください。届かなかったファイルは各カードから再ダウンロードできます。"
              ),
        variant: "success"
      });
    } catch (caught) {
      handleApiError(caught, t("Export failed", "書き出しに失敗しました"), {
        title:
          made.length > 0
            ? t(`Stopped after ${made.join(", ")}`, `${made.join("、")} の後で停止しました`)
            : t("Export failed", "書き出しに失敗しました")
      });
    } finally {
      setProgress(null);
    }
  };

  usePrimaryAction({
    label: t(view.next.action.en, view.next.action.ja),
    run: () => {
      if (!view.next.blocked) void create();
    },
    disabledReason: view.next.blocked ? t(view.next.blocked.en, view.next.blocked.ja) : null,
    busy,
    anchor
  });
  usePageShell({
    checkErrors: checks ? checks.error_count : null,
    checkWarnings: checks ? checks.warning_count : null
  });

  const toggle = (format: ExportFormat) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(format)) next.delete(format);
      else next.add(format);
      return next;
    });
  const setOption = (patch: Partial<ShapefileOptions>) => setOptions((current) => ({ ...current, ...patch }));
  const { status } = view;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 items-start gap-8 overflow-auto px-14 pb-6 pt-7">
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <h1 className="font-display text-[30px] font-semibold leading-tight text-foreground">
            {t(`Deliver ${station}`, `${station} を書き出す`)}
          </h1>

          <section
            aria-label={t("Before you deliver", "書き出しの前に")}
            className={cn(
              "flex items-center gap-3 rounded-xl p-3.5",
              status.tone === "ok" && "bg-accent",
              status.tone === "danger" && "bg-destructive-muted",
              status.tone === "stale" && "bg-warning-surface"
            )}
          >
            {status.tone === "ok" ? (
              <CheckCircle2 aria-hidden="true" className="h-[22px] w-[22px] shrink-0 text-primary" />
            ) : (
              <AlertTriangle
                aria-hidden="true"
                className={cn(
                  "h-[22px] w-[22px] shrink-0",
                  status.tone === "danger" ? "text-destructive" : "text-warning-foreground"
                )}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p
                className={cn(
                  "text-sm font-semibold",
                  status.tone === "ok" && "text-primary",
                  status.tone === "danger" && "text-destructive",
                  status.tone === "stale" && "text-warning-foreground"
                )}
              >
                {t(status.title.en, status.title.ja)}
              </p>
              <p className="text-[12.5px] leading-[1.45] text-muted-foreground">
                {t(status.detail.en, status.detail.ja)}
              </p>
            </div>
            {status.action ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 bg-card"
                disabled={checking}
                onClick={() =>
                  status.action?.goes === "check-again" ? void checkAgain() : navigate(projectPath(sessionId, "check"))
                }
              >
                {t(status.action.label.en, status.action.label.ja)}
              </Button>
            ) : null}
          </section>

          {view.groups.map((group) => (
            <section key={group.id} aria-labelledby={`deliver-${group.id}`} className="flex flex-col gap-2.5">
              <div className="flex items-baseline gap-2.5">
                <h2 id={`deliver-${group.id}`} className={cn(label, "text-primary")}>
                  {t(group.label.en, group.label.ja)}
                </h2>
                <p className="text-xs text-muted-foreground">{t(group.note.en, group.note.ja)}</p>
              </div>
              <div className="flex items-stretch gap-3">
                {group.outputs.map((output) => (
                  <OutputChoice
                    key={output.format}
                    output={output}
                    onToggle={() => toggle(output.format)}
                    onDownloadAgain={created.has(output.format) && !busy ? () => void create([output.format]) : null}
                  />
                ))}
              </div>
            </section>
          ))}

          {view.showEncoding ? (
            <section aria-labelledby="deliver-options" className="flex flex-col gap-3">
              <h2 id="deliver-options" className={cn(label, "text-muted-foreground")}>
                {t("Shapefile options", "シェープファイルの設定")}
              </h2>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
                <div className="flex gap-4">
                  {view.showPrefix ? (
                    <Field
                      className="flex-1"
                      label={t("File prefix", "ファイルの接頭辞")}
                      required
                      hint={t(
                        `Every ODC file starts with it, e.g. "${options.prefix.trim() || "TokyoSta"}_1_Floor".`,
                        `ODC のすべてのファイル名の先頭に付きます（例: "${options.prefix.trim() || "TokyoSta"}_1_Floor"）。`
                      )}
                    >
                      {(id) => (
                        <div className="flex gap-2">
                          <Input
                            id={id}
                            required
                            value={options.prefix}
                            placeholder="TokyoSta"
                            onChange={(event) => setOption({ prefix: event.target.value })}
                          />
                          {view.suggestedPrefix ? (
                            <Button
                              variant="outline"
                              className="shrink-0"
                              onClick={() =>
                                setOption({
                                  prefix: view.suggestedPrefix ?? ""
                                })
                              }
                            >
                              {t(`Use ${view.suggestedPrefix}`, `${view.suggestedPrefix} を使う`)}
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </Field>
                  ) : null}
                  <Field className="flex-1" label={t("Encoding", "文字コード")}>
                    {(id) => (
                      <Select
                        value={options.encoding}
                        onValueChange={(value) =>
                          setOption({
                            encoding: value as ShapefileExportEncoding
                          })
                        }
                      >
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="preserve_source">
                            {t("Preserve source encoding", "元データの文字コードを維持")}
                          </SelectItem>
                          <SelectItem value="utf-8">UTF-8</SelectItem>
                          <SelectItem value="cp932">CP932 (Shift-JIS)</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                </div>
                {view.showFieldOptions ? <FieldOptions options={options} onChange={setOption} /> : null}
              </div>
            </section>
          ) : null}
        </main>

        <aside className="flex w-[420px] shrink-0 flex-col gap-3.5">
          <section
            aria-labelledby="deliver-files"
            className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5"
          >
            <h2 id="deliver-files" className="font-display text-xl font-semibold text-foreground">
              {t("What you’ll get", "作成されるファイル")}
            </h2>
            {view.tree.length > 0 ? (
              <ul
                aria-label={t("Files", "ファイル")}
                className="flex flex-col gap-1.5 rounded-lg bg-muted p-3.5 font-mono text-xs text-foreground"
              >
                {view.tree.map((node) => (
                  <li key={node.filename} className="flex flex-col gap-1">
                    <span className="break-all">└ {node.filename}</span>
                    {node.lines.map((line) => (
                      <span key={line.en} className="break-words pl-4 text-[11px] text-muted-foreground">
                        └ {t(line.en, line.ja)}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg bg-muted p-3.5 text-[12.5px] text-muted-foreground">
                {contents === null
                  ? t("Listing the files…", "ファイルを確認しています…")
                  : t("Choose an output to see its files.", "出力を選ぶと、そのファイルが表示されます。")}
              </p>
            )}
            {view.crs.length > 0 ? (
              <p className="rounded-lg bg-info-muted p-2.5 text-xs leading-[1.45] text-info">
                {t("Coordinates: ", "座標系：")}
                {view.crs.map((line) => t(line.en, line.ja)).join(t("; ", "、"))}
                {t(".", "。")}
              </p>
            ) : null}
            <h3 className={cn(label, "text-muted-foreground")}>{t("Last checks", "最終チェック")}</h3>
            <ul className="flex flex-col gap-2.5">
              {view.lastChecks.map((row) => (
                <li
                  key={row.text.en}
                  className={cn(
                    "flex items-center gap-2 text-[12.5px]",
                    row.tone === "wait"
                      ? "text-warning-foreground"
                      : row.tone === "danger"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  )}
                >
                  {TONE_ICON[row.tone]}
                  {t(row.text.en, row.text.ja)}
                </li>
              ))}
            </ul>
          </section>
          {note.loaded ? <HandoverNote sessionId={sessionId} station={station} note={note.note} /> : null}
        </aside>
      </div>
      <NextBar
        ref={anchor}
        step={view.next}
        progress={progress}
        busyLabel={{ en: "Creating…", ja: "作成中…" }}
        onGo={() => void create()}
      />
    </div>
  );
}

function OutputChoice({
  output,
  onToggle,
  onDownloadAgain
}: {
  output: OutputCard;
  onToggle: () => void;
  /** Set once this output was created on this visit. */
  onDownloadAgain: (() => void) | null;
}) {
  const { t } = useUiLanguage();
  const id = `deliver-output-${output.format}`;
  const disabled = output.unavailable !== null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-2 rounded-[14px] border bg-card p-4",
        output.selected ? "border-[1.5px] border-primary" : "border-border",
        disabled && "opacity-60"
      )}
    >
      <label
        htmlFor={id}
        className={cn("flex flex-1 flex-col gap-2", disabled ? "cursor-not-allowed" : "cursor-pointer")}
      >
        <span className="flex items-start gap-2.5">
          <Checkbox
            id={id}
            className="mt-px h-5 w-5 rounded-[5px]"
            checked={output.selected}
            disabled={disabled}
            onCheckedChange={onToggle}
          />
          <span className="text-sm font-semibold text-foreground">{t(output.title.en, output.title.ja)}</span>
        </span>
        <span className="text-[12.5px] leading-[1.48] text-muted-foreground">{t(output.note.en, output.note.ja)}</span>
        <span className="break-all pt-1 font-mono text-[11px] text-muted-foreground">
          {output.unavailable
            ? t(output.unavailable.en, output.unavailable.ja)
            : output.needsPrefix
              ? t("Named from the file prefix below", "下のファイル接頭辞から名前が付きます")
              : (output.filename ?? "…")}
        </span>
        {output.pill ? (
          <span className="self-start rounded-full bg-info-muted px-2.5 py-[3px] text-[11px] font-medium text-info">
            {t(output.pill.en, output.pill.ja)}
          </span>
        ) : null}
      </label>
      {onDownloadAgain && output.filename ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto self-start px-0 py-0 text-xs text-primary underline-offset-2 font-medium hover:bg-transparent hover:text-primary hover:underline"
          aria-label={t(`Download ${output.filename} again`, `${output.filename} をもう一度ダウンロード`)}
          onClick={onDownloadAgain}
        >
          {t("Download again", "もう一度ダウンロード")}
        </Button>
      ) : null}
    </div>
  );
}

function FieldOptions({
  options,
  onChange
}: {
  options: ShapefileOptions;
  onChange: (patch: Partial<ShapefileOptions>) => void;
}) {
  const { t } = useUiLanguage();
  const toggleNewField = (checked: boolean) => {
    const source = options.sourceCategoryField.trim();
    const current = options.categoryField.trim().toLowerCase();
    if (checked) {
      const replace = !current || (source && current === source.toLowerCase());
      onChange({
        writeToNewField: true,
        ...(replace ? { categoryField: "IMDF_CAT" } : {})
      });
    } else {
      onChange({
        writeToNewField: false,
        ...(source ? { categoryField: source } : {})
      });
    }
  };
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        {t("Field names and legacy codes", "フィールド名と旧コード")}
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <label className="flex cursor-pointer items-start gap-2 text-[13px] leading-[18px] text-foreground">
          <Checkbox
            className="mt-0.5"
            checked={options.writeToNewField}
            onCheckedChange={(next) => toggleNewField(next === true)}
          />
          <span>
            {t(
              "Write IMDF categories to a new field instead of overwriting the existing code/category field.",
              "既存のコード/カテゴリ列を上書きせず、新しい列に IMDF カテゴリを書き込みます。"
            )}
          </span>
        </label>
        <Field
          label={
            options.writeToNewField
              ? t("New IMDF category field", "新しい IMDF カテゴリ列")
              : t("Existing category/code field to overwrite", "上書きする既存のカテゴリ/コード列")
          }
          hint={
            options.writeToNewField
              ? undefined
              : t(
                  "Defaults to your mapped source column, so exports replace old codes with IMDF categories.",
                  "既定値は対応付け済みの元列で、旧コードを IMDF カテゴリに置き換えます。"
                )
          }
        >
          {(id) => (
            <Input
              id={id}
              value={options.categoryField}
              onChange={(event) => onChange({ categoryField: event.target.value })}
              placeholder={options.writeToNewField ? "IMDF_CAT" : options.sourceCategoryField || "CATEGORY"}
            />
          )}
        </Field>
        <Field label={t("Legacy code field (optional)", "旧コード列（任意）")}>
          {(id) => (
            <Input
              id={id}
              value={options.legacyCodeField}
              onChange={(event) => onChange({ legacyCodeField: event.target.value })}
              placeholder="COMPANY_CODE"
            />
          )}
        </Field>
        <Field
          label={t("Legacy mappings (optional)", "旧コードの対応（任意）")}
          hint={t(
            "One per line as category=CODE. Applied only when a legacy code field is set.",
            "1行に1つ、category=CODE の形式で。旧コード列を設定したときのみ適用されます。"
          )}
        >
          {(id) => (
            <Textarea
              id={id}
              className="font-mono text-xs"
              rows={4}
              value={options.legacyMapText}
              onChange={(event) => onChange({ legacyMapText: event.target.value })}
              placeholder={"room=B0001\noffice=B0002"}
            />
          )}
        </Field>
      </div>
    </details>
  );
}
