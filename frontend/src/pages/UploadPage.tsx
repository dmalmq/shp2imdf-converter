import { useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";

import { importShapefiles, type ImportResponse } from "../api/client";
import { useToast } from "../components/shared/ToastProvider";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";
import { Button, Card, Badge } from "../components/ui";

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


export function UploadPage() {
  const navigate = useNavigate();
  const setSessionId = useAppStore((state) => state.setSessionId);
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);
  const setFiles = useAppStore((state) => state.setFiles);
  const setCleanupSummary = useAppStore((state) => state.setCleanupSummary);
  const setSessionExpiredMessage = useAppStore((state) => state.setSessionExpiredMessage);
  const pushToast = useToast();
  const handleApiError = useApiErrorHandler();
  const { t } = useUiLanguage();

  const [queuedFiles, setQueuedFiles] = useState<QueuedUploadFile[]>([]);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
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

    setLoading(true);
    setProgress(0);
    setError(null);
    try {
      const payload = await importShapefiles(selectedFiles, setProgress);
      setSessionExpiredMessage(null);
      setSessionId(payload.session_id);
      setFiles(payload.files);
      setCleanupSummary(payload.cleanup_summary);
      setLastCleanup(payload.cleanup_summary);
      setCurrentScreen("wizard");

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

      // Auto-navigate to wizard
      navigate("/wizard");
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

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10">
      <Card padding="lg" className="w-full max-w-2xl animate-fade-in-up">
        {/* Cleanup summary banner (if exists from a previous import in same session) */}
        {lastCleanup && !loading ? (
          <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--color-primary)]/20 bg-[var(--color-primary-muted)] px-3 py-2">
            <button
              type="button"
              className="flex w-full items-center justify-between text-xs font-medium text-[var(--color-primary)]"
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
              <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-text-secondary)]">
                <li>{t("Multipolygons exploded", "マルチポリゴン分解")}: {lastCleanup.multipolygons_exploded}</li>
                <li>{t("Rings closed", "リング閉鎖")}: {lastCleanup.rings_closed}</li>
                <li>{t("Features reoriented", "フィーチャー方向修正")}: {lastCleanup.features_reoriented}</li>
                <li>{t("Empty features dropped", "空フィーチャー削除")}: {lastCleanup.empty_features_dropped}</li>
                <li>{t("Coordinates rounded", "座標丸め")}: {lastCleanup.coordinates_rounded}</li>
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* Dropzone */}
        <div
          {...getRootProps()}
          className={[
            "flex flex-col items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer",
            isDragActive
              ? "border-[var(--color-primary)] bg-[var(--color-primary-muted)]"
              : "border-[var(--color-border)] bg-[var(--color-surface-muted)] hover:border-[var(--color-primary)]/50"
          ].join(" ")}
        >
          <input {...getInputProps()} />
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            className="mb-3 text-[var(--color-text-muted)]"
          >
            <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" />
            <path d="M20 16v10M15 21l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {isDragActive ? (
            <p className="text-sm font-medium text-[var(--color-primary)]">
              {t("Drop files here...", "ここにファイルをドロップ...")}
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-[var(--color-text)]">
                {t("Drop files here or click to browse", "ファイルをドロップまたはクリックして選択")}
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                .shp, .dbf, .shx, .prj, .gpkg, .zip
              </p>
            </>
          )}
        </div>

        {/* File chips */}
        {hasFiles ? (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                {selectedStemCount + geoPackageRows.filter((r) => r.selected).length + archiveRows.filter((r) => r.selected).length} {t("of", "/")} {stemRows.length + geoPackageRows.length + archiveRows.length} {t("datasets selected", "データセット選択")}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              {groupedStemRows.flatMap((group) =>
                group.rows.map((row) => (
                  <label
                    key={row.key}
                    className={[
                      "group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer",
                      row.selected
                        ? "border-[var(--color-primary)]/30 bg-[var(--color-primary-muted)] text-[var(--color-primary)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"
                    ].join(" ")}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={row.selected}
                      onChange={() => toggleStemGroup(row.key)}
                    />
                    <span className="truncate max-w-[180px]">{row.stem}</span>
                    <Badge variant={row.selected ? "primary" : "default"}>{row.extensions.map((e) => `.${e}`).join(", ")}</Badge>
                    <button
                      type="button"
                      className="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-current hover:text-[var(--color-error)]"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeStemGroup(row.key);
                      }}
                      title={t("Remove", "削除")}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M3 3l6 6M9 3l-6 6" />
                      </svg>
                    </button>
                  </label>
                ))
              )}

              {geoPackageRows.map((item) => (
                <label
                  key={item.id}
                  className={[
                    "group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer",
                    item.selected
                      ? "border-[var(--color-success)]/30 bg-[var(--color-success-muted)] text-[var(--color-success)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={item.selected}
                    onChange={() => toggleGeoPackage(item.id)}
                  />
                  <span className="truncate max-w-[180px]">{item.file.name}</span>
                  <Badge variant={item.selected ? "success" : "default"}>.gpkg</Badge>
                  <button
                    type="button"
                    className="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-current hover:text-[var(--color-error)]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeFile(item.id);
                    }}
                    title={t("Remove", "削除")}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </label>
              ))}

              {archiveRows.map((item) => (
                <label
                  key={item.id}
                  className={[
                    "group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer",
                    item.selected
                      ? "border-[var(--color-warning)]/30 bg-[var(--color-warning-muted)] text-[var(--color-warning)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={item.selected}
                    onChange={() => toggleArchive(item.id)}
                  />
                  <span className="truncate max-w-[180px]">{item.file.name}</span>
                  <Badge variant={item.selected ? "warning" : "default"}>.zip</Badge>
                  <button
                    type="button"
                    className="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-current hover:text-[var(--color-error)]"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeFile(item.id);
                    }}
                    title={t("Remove", "削除")}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {/* Error */}
        {error ? (
          <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error-muted)] px-3 py-2 text-xs text-[var(--color-error)]">
            {error}
          </div>
        ) : null}

        {/* Import button */}
        <div className="mt-6">
          <Button
            variant="primary"
            className="relative w-full overflow-hidden"
            onClick={() => void runImportAndContinue()}
            disabled={loading || selectedFileCount === 0}
          >
            {/* Progress bar overlay */}
            {loading ? (
              <span
                className="absolute inset-y-0 left-0 bg-white/20 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            ) : null}
            <span className="relative">
              {loading
                ? t(`Importing... ${progress}%`, `インポート中... ${progress}%`)
                : hasFiles
                  ? t("Import & Continue", "インポートして次へ")
                  : t("Import & Continue", "インポートして次へ")}
            </span>
          </Button>
        </div>
      </Card>
    </div>
  );
}
