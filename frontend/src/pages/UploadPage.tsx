import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";

import {
  importImdfShapefiles,
  importShapefiles,
  type ImportResponse
} from "../api/client";
import { useToast } from "../components/shared/ToastProvider";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";
import { Button, Card, Badge, Checkbox, DisabledHint } from "../components/ui";
import { usePrimaryAction } from "../components/shell/ShellContext";
import { projectPath } from "../components/shell/stages";
import { cn } from "@/lib/utils";

/**
 * One queued dataset.
 *
 * Shapefile stems, GeoPackages and archives used to be three near-identical
 * blocks of pill markup tinted accent/green/amber by file kind, which spent
 * colour on a distinction nobody acts on and hid both the checkbox (sr-only)
 * and the remove button (hover-only). One row, one renderer, kind as a label.
 */
function QueuedRow({
  name,
  detail,
  kind,
  selected,
  onToggle,
  onRemove,
  removeLabel
}: {
  name: string;
  detail: string;
  kind: string | null;
  selected: boolean;
  onToggle: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-2.5 py-2 last:border-b-0">
      <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[13px] font-medium leading-[18px]",
            selected ? "text-foreground" : "text-muted-foreground"
          )}
          title={name}
        >
          {name}
        </span>
        <span className="truncate font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
          {detail}
        </span>
      </span>
      {/* Only worth the row space when the queue actually mixes kinds. */}
      {kind ? (
        <Badge variant="outline" className="shrink-0 font-mono tracking-[0.04em]">
          {kind}
        </Badge>
      ) : null}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type QueuedUploadFile = {
  id: string;
  file: File;
  selected: boolean;
  extension: string;
  stem: string | null;
  kind: "shapefile" | "gpkg" | "archive";
};

type StemRow = {
  key: string;
  stem: string;
  suffixGroup: string;
  selected: boolean;
  fileCount: number;
  extensions: string[];
};

const SHAPEFILE_EXTENSIONS = new Set([".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix"]);
const GEOPACKAGE_EXTENSIONS = new Set([".gpkg"]);
const ARCHIVE_EXTENSIONS = new Set([".zip"]);
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([...SHAPEFILE_EXTENSIONS, ...GEOPACKAGE_EXTENSIONS, ...ARCHIVE_EXTENSIONS]);
const DROPZONE_ACCEPT = {
  "application/octet-stream": [".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix"],
  "application/geopackage+sqlite3": [".gpkg"],
  "application/x-sqlite3": [".gpkg"],
  "application/zip": [".zip"]
} as const;

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  if (index < 0) {
    return "";
  }
  return name.slice(index).toLowerCase();
}

function fileStem(name: string, extension: string): string {
  if (!extension || !name.toLowerCase().endsWith(extension)) {
    return name;
  }
  return name.slice(0, name.length - extension.length);
}

function inferStemSuffixGroup(stem: string): string {
  const tokens = stem.split(/[_\-\s]+/).filter(Boolean);
  if (tokens.length === 0) {
    return "Other";
  }
  return tokens[tokens.length - 1];
}

function toQueuedUploadFile(file: File): QueuedUploadFile | null {
  const extension = fileExtension(file.name);
  if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
    return null;
  }

  const stem = ARCHIVE_EXTENSIONS.has(extension) ? null : fileStem(file.name, extension);
  const kind = ARCHIVE_EXTENSIONS.has(extension)
    ? "archive"
    : GEOPACKAGE_EXTENSIONS.has(extension)
      ? "gpkg"
      : "shapefile";

  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2, 10)}`,
    file,
    selected: true,
    extension,
    stem,
    kind
  };
}


type UploadPageProps = {
  /**
   * Shown from a project's Bring in: importing here does not add to that
   * project. Otherwise this is `/p/new`, which starts from no project and
   * queues whatever the hub's drop zone handed over.
   */
  fromProject?: boolean;
};

export function UploadPage({ fromProject = false }: UploadPageProps = {}) {
  const navigate = useNavigate();
  const switchProject = useAppStore((state) => state.switchProject);
  const projectLoaded = useAppStore((state) => state.projectLoaded);
  const setCleanupSummary = useAppStore((state) => state.setCleanupSummary);
  const setSessionExpiredMessage = useAppStore((state) => state.setSessionExpiredMessage);
  const pushToast = useToast();
  const handleApiError = useApiErrorHandler();
  const { t } = useUiLanguage();

  const dropped = useDroppedFiles();
  const [queuedFiles, setQueuedFiles] = useState<QueuedUploadFile[]>(() =>
    dropped
      .map(toQueuedUploadFile)
      .filter((item): item is QueuedUploadFile => item !== null)
  );

  useEffect(() => {
    if (!fromProject) switchProject(null);
  }, [fromProject, switchProject]);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [importMode, setImportMode] = useState<"standard" | "imdf_shapefile">("standard");
  const [preferFilenameFloor, setPreferFilenameFloor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanupExpanded, setCleanupExpanded] = useState(false);
  const [lastCleanup, setLastCleanup] = useState<ImportResponse["cleanup_summary"] | null>(null);

  const onDrop = (acceptedFiles: File[]) => {
    const parsed = acceptedFiles.map(toQueuedUploadFile);
    const valid = parsed.filter((item): item is QueuedUploadFile => item !== null);
    const skippedCount = acceptedFiles.length - valid.length;

    if (valid.length > 0) {
      setQueuedFiles((previous) => [...previous, ...valid]);
      setError(null);
    }

    if (skippedCount > 0) {
      pushToast({
        title: t("Unsupported files skipped", "Unsupported files skipped"),
        description: t(
          `${skippedCount} file(s) were ignored because they are not shapefile components, GeoPackages, or zip archives.`,
          `${skippedCount} file(s) were ignored because they are not shapefile components, GeoPackages, or zip archives.`
        ),
        variant: "info"
      });
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    accept: DROPZONE_ACCEPT
  });

  const stemRows = useMemo(() => {
    const byStem = new Map<string, { stem: string; files: QueuedUploadFile[] }>();
    queuedFiles
      .filter((item) => item.kind === "shapefile" && item.stem)
      .forEach((item) => {
        const key = item.stem!.toLowerCase();
        const current = byStem.get(key);
        if (current) {
          current.files.push(item);
          return;
        }
        byStem.set(key, { stem: item.stem!, files: [item] });
      });

    return [...byStem.entries()]
      .map(([key, value]) => {
        const extensions = [...new Set(value.files.map((item) => item.extension.replace(".", "")))].sort((a, b) => a.localeCompare(b));
        return {
          key,
          stem: value.stem,
          suffixGroup: inferStemSuffixGroup(value.stem),
          selected: value.files.every((item) => item.selected),
          fileCount: value.files.length,
          extensions
        };
      })
      .sort((left, right) => {
        const groupOrder = left.suffixGroup.localeCompare(right.suffixGroup);
        if (groupOrder !== 0) {
          return groupOrder;
        }
        return left.stem.localeCompare(right.stem);
      });
  }, [queuedFiles]);

  const groupedStemRows = useMemo(() => {
    const grouped = new Map<string, StemRow[]>();
    stemRows.forEach((row) => {
      const rows = grouped.get(row.suffixGroup);
      if (rows) {
        rows.push(row);
      } else {
        grouped.set(row.suffixGroup, [row]);
      }
    });

    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([suffixGroup, rows]) => ({
        suffixGroup,
        rows: rows.sort((left, right) => left.stem.localeCompare(right.stem))
      }));
  }, [stemRows]);

  const archiveRows = useMemo(
    () => queuedFiles.filter((item) => item.kind === "archive"),
    [queuedFiles]
  );
  const geoPackageRows = useMemo(
    () => queuedFiles.filter((item) => item.kind === "gpkg"),
    [queuedFiles]
  );

  const selectedFiles = useMemo(
    () => queuedFiles.filter((item) => item.selected).map((item) => item.file),
    [queuedFiles]
  );
  const selectedFileCount = selectedFiles.length;

  const selectedStemCount = useMemo(
    () => stemRows.filter((row) => row.selected).length,
    [stemRows]
  );

  // Counted in datasets, not files: a shapefile is five files the user thinks
  // of as one thing, so a file count reads as a wrong number.
  const totalRowCount = stemRows.length + geoPackageRows.length + archiveRows.length;
  const selectedRowCount =
    selectedStemCount +
    geoPackageRows.filter((item) => item.selected).length +
    archiveRows.filter((item) => item.selected).length;
  const showStemGroups =
    groupedStemRows.length > 1 || (groupedStemRows.length === 1 && archiveRows.length + geoPackageRows.length > 0);
  const mixedKinds =
    [stemRows.length, geoPackageRows.length, archiveRows.length].filter((count) => count > 0).length > 1;

  const setAllSelected = (selected: boolean) => {
    setQueuedFiles((previous) => previous.map((item) => ({ ...item, selected })));
  };

  const toggleStemGroup = (stemKey: string) => {
    const row = stemRows.find((item) => item.key === stemKey);
    if (!row) {
      return;
    }
    const nextSelected = !row.selected;
    setQueuedFiles((previous) =>
      previous.map((item) => {
        if (item.kind !== "shapefile" || !item.stem) {
          return item;
        }
        if (item.stem.toLowerCase() !== stemKey) {
          return item;
        }
        return { ...item, selected: nextSelected };
      })
    );
  };

  const toggleArchive = (id: string) => {
    setQueuedFiles((previous) =>
      previous.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item))
    );
  };

  const toggleGeoPackage = (id: string) => {
    setQueuedFiles((previous) =>
      previous.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item))
    );
  };

  const removeFile = (id: string) => {
    setQueuedFiles((prev) => prev.filter((item) => item.id !== id));
  };

  const removeStemGroup = (stemKey: string) => {
    setQueuedFiles((prev) =>
      prev.filter((item) => {
        if (item.kind !== "shapefile" || !item.stem) return true;
        return item.stem.toLowerCase() !== stemKey;
      })
    );
  };

  // Import & auto-continue to wizard
  const runImportAndContinue = async () => {
    if (selectedFiles.length === 0) {
      const message = t(
        "Select at least one shapefile group, GeoPackage, or zip archive before importing.",
        "Select at least one shapefile group, GeoPackage, or zip archive before importing."
      );
      setError(message);
      return;
    }
    if (importMode === "imdf_shapefile" && selectedFiles.some((file) => fileExtension(file.name) === ".gpkg")) {
      const message = t(
        "IMDF-schema shapefile import only accepts shapefile components or zip archives.",
        "IMDF-schema shapefile import only accepts shapefile components or zip archives."
      );
      setError(message);
      return;
    }

    setLoading(true);
    setProgress(0);
    setError(null);
    try {
      const payload =
        importMode === "imdf_shapefile"
          ? await importImdfShapefiles(selectedFiles, setProgress, preferFilenameFloor)
          : await importShapefiles(selectedFiles, setProgress);
      setSessionExpiredMessage(null);
      const imdfShapefiles = payload.import_profile === "imdf_shapefile";
      switchProject(payload.session_id);
      projectLoaded(payload.session_id, {
        importProfile: payload.import_profile,
        files: payload.files,
        reviewReached: imdfShapefiles
      });
      setCleanupSummary(payload.cleanup_summary);
      setLastCleanup(payload.cleanup_summary);

      pushToast({
        title: t("Import complete", "インポート完了"),
        description: t(`${payload.files.length} dataset(s) imported.`, `${payload.files.length} 件のデータセットをインポートしました。`),
        variant: "success"
      });

      if (payload.warnings.length > 0) {
        pushToast({
          title: t("Import warnings", "インポート警告"),
          description: t(
            `${payload.warnings.length} warning(s) reported during import.`,
            `${payload.warnings.length} warning(s) reported during import.`
          ),
          variant: "info"
        });
      }

      navigate(projectPath(payload.session_id, imdfShapefiles ? "check" : "set-up"));
    } catch (caught) {
      const message = handleApiError(caught, t("Import failed", "インポートに失敗しました"), {
        title: t("Import failed", "インポート失敗")
      });
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const hasFiles = stemRows.length > 0 || geoPackageRows.length > 0 || archiveRows.length > 0;

  const importLabel = loading
    ? t(`Importing… ${progress}%`, `インポート中… ${progress}%`)
    : importMode === "imdf_shapefile"
      ? t("Import to Review", "レビューへインポート")
      : t("Import & Continue", "インポートして次へ");
  const importBlockedReason =
    selectedFileCount === 0 && !loading
      ? t("Add at least one shapefile to import", "インポートするシェープファイルを1つ以上追加してください")
      : null;
  const importButtonRef = useRef<HTMLDivElement>(null);
  usePrimaryAction({
    label: importLabel,
    run: () => void runImportAndContinue(),
    disabledReason: importBlockedReason,
    busy: loading,
    anchor: importButtonRef
  });

  const importButton = (
    <Button
      variant="default"
      className="relative w-full overflow-hidden"
      onClick={() => void runImportAndContinue()}
      disabled={loading || selectedFileCount === 0}
    >
      {/* Progress bar overlay */}
      {loading ? (
        <span
          className="absolute inset-y-0 left-0 bg-primary-foreground/20 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      ) : null}
      <span className="relative">
        {importLabel}
      </span>
    </Button>
  );

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10">
      <div className="flex w-full max-w-2xl animate-fade-in-up flex-col gap-5">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl font-semibold leading-9 tracking-tight text-foreground">
            {t("Import shapefiles", "シェープファイルをインポート")}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t(
              "Classify and map source shapefiles, then review and export.",
              "元データを分類・マッピングし、レビューして書き出します。"
            )}
          </p>
          {fromProject ? (
            <p role="note" className="text-sm font-medium leading-5 text-foreground">
              {t(
                "Bringing in files starts a new project. This one stays as it is.",
                "ファイルを取り込むと新しいプロジェクトになります。このプロジェクトはそのまま残ります。"
              )}
            </p>
          ) : null}
        </div>

        <Card className="p-6">
        {/* Cleanup summary banner (if exists from a previous import in same session) */}
        {lastCleanup && !loading ? (
          <div className="mb-5 rounded-md border border-primary/20 bg-accent px-3 py-2">
            <button
              type="button"
              className="flex w-full items-center justify-between text-xs font-medium text-primary"
              onClick={() => setCleanupExpanded((prev) => !prev)}
            >
              <span>{t("Cleanup Summary", "クリーンアップサマリー")}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className={`transition-transform ${cleanupExpanded ? "rotate-180" : ""}`}
              >
                <path d="M3 5l4 4 4-4" />
              </svg>
            </button>
            {cleanupExpanded ? (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                <li>{t("Multipolygons exploded", "マルチポリゴン分解")}: {lastCleanup.multipolygons_exploded}</li>
                <li>{t("Rings closed", "リング閉鎖")}: {lastCleanup.rings_closed}</li>
                <li>{t("Features reoriented", "フィーチャー方向修正")}: {lastCleanup.features_reoriented}</li>
                <li>{t("Empty features dropped", "空フィーチャー削除")}: {lastCleanup.empty_features_dropped}</li>
                <li>{t("Coordinates rounded", "座標丸め")}: {lastCleanup.coordinates_rounded}</li>
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* One choice between two modes, so it reads as a switch rather than
            two cards competing with the drop target below them. */}
        <div className="mb-5 flex flex-col items-center gap-2">
          <div
            role="group"
            aria-label={t("Import profile", "インポート形式")}
            className="inline-flex gap-0.5 rounded-md bg-muted p-1"
          >
            {([
              ["standard", t("Standard", "標準")],
              ["imdf_shapefile", t("IMDF schema", "IMDFスキーマ")]
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={importMode === mode}
                onClick={() => setImportMode(mode)}
                className={cn(
                  "rounded-sm px-3 py-1.5 text-[13px] font-medium leading-[18px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  importMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-center text-[13px] leading-[18px] text-muted-foreground">
            {importMode === "standard"
              ? t(
                  "Source shapefiles are classified and mapped in the wizard.",
                  "元データはウィザードで分類・マッピングされます。"
                )
              : t(
                  "Already-reviewed features open straight in Review and export as Open Data Contest 2026 shapefiles.",
                  "レビュー済みのフィーチャーを直接レビュー画面で開き、オープンデータコンテスト2026形式で書き出します。"
                )}
          </p>
        </div>

        {importMode === "imdf_shapefile" ? (
          <label className="mb-5 flex items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
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
        ) : null}

        {/* Dropzone */}
        <div
          {...getRootProps()}
          className={[
            "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer",
            isDragActive
              ? "border-primary bg-accent"
              : "border-border bg-muted hover:border-primary/50"
          ].join(" ")}
        >
          <input {...getInputProps()} />
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            className="mb-3 text-muted-foreground"
          >
            <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" />
            <path d="M20 16v10M15 21l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {isDragActive ? (
            <p className="text-sm font-medium text-primary">
              {t("Drop files here...", "ここにファイルをドロップ...")}
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">
                {t("Drop files here or click to browse", "ファイルをドロップまたはクリックして選択")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                .shp, .dbf, .shx, .prj, .gpkg, .zip
              </p>
            </>
          )}
        </div>

        {/* File chips */}
        {hasFiles ? (
          <div className="mt-5 flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                {t(
                  `${selectedRowCount} of ${totalRowCount} datasets selected`,
                  `${totalRowCount} 件中 ${selectedRowCount} 件を選択`
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                onClick={() => setAllSelected(selectedRowCount < totalRowCount)}
              >
                {selectedRowCount < totalRowCount
                  ? t("Select all", "すべて選択")
                  : t("Select none", "選択を解除")}
              </Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {groupedStemRows.map((group) => (
                <Fragment key={group.suffixGroup}>
                  {/* The rows were already sorted by this token and the grouping
                      was invisible; naming it is what makes the order legible. */}
                  {showStemGroups ? (
                    <p className="border-b border-border bg-muted/40 px-2.5 py-1 font-mono text-[10px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">
                      {group.suffixGroup}
                    </p>
                  ) : null}
                  {group.rows.map((row) => (
                    <QueuedRow
                      key={row.key}
                      name={row.stem}
                      detail={row.extensions.map((extension) => `.${extension}`).join(", ")}
                      kind={mixedKinds ? "SHP" : null}
                      selected={row.selected}
                      onToggle={() => toggleStemGroup(row.key)}
                      onRemove={() => removeStemGroup(row.key)}
                      removeLabel={t(`Remove ${row.stem}`, `${row.stem} を削除`)}
                    />
                  ))}
                </Fragment>
              ))}

              {geoPackageRows.map((item) => (
                <QueuedRow
                  key={item.id}
                  name={item.file.name}
                  detail={formatFileSize(item.file.size)}
                  kind={mixedKinds ? "GPKG" : null}
                  selected={item.selected}
                  onToggle={() => toggleGeoPackage(item.id)}
                  onRemove={() => removeFile(item.id)}
                  removeLabel={t(`Remove ${item.file.name}`, `${item.file.name} を削除`)}
                />
              ))}

              {archiveRows.map((item) => (
                <QueuedRow
                  key={item.id}
                  name={item.file.name}
                  detail={formatFileSize(item.file.size)}
                  kind={mixedKinds ? "ZIP" : null}
                  selected={item.selected}
                  onToggle={() => toggleArchive(item.id)}
                  onRemove={() => removeFile(item.id)}
                  removeLabel={t(`Remove ${item.file.name}`, `${item.file.name} を削除`)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* Error */}
        {error ? (
          <div className="mt-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {/* Import button — says why it is unavailable rather than only greying out */}
        <div ref={importButtonRef} className="mt-6">
          <DisabledHint hint={importBlockedReason}>
            {importButton}
          </DisabledHint>
        </div>

      </Card>
      </div>
    </div>
  );
}