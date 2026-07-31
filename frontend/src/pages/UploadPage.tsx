import { useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";

import {
  convertIllustrator,
  importImdf,
  importImdfShapefiles,
  importShapefiles,
  type IllustratorConversionReport,
  type ImportResponse
} from "../api/client";
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
  const setImportProfile = useAppStore((state) => state.setImportProfile);
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
  const [importMode, setImportMode] = useState<"standard" | "imdf_shapefile">("standard");
  const [error, setError] = useState<string | null>(null);
  const [cleanupExpanded, setCleanupExpanded] = useState(false);
  const [lastCleanup, setLastCleanup] = useState<ImportResponse["cleanup_summary"] | null>(null);
  const [imdfLoading, setImdfLoading] = useState(false);
  const [imdfError, setImdfError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiReport, setAiReport] = useState<IllustratorConversionReport | null>(null);

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

  const runImdfImport = async (file: File) => {
    setImdfLoading(true);
    setImdfError(null);
    try {
      const payload = await importImdf(file);
      setSessionExpiredMessage(null);
      setSessionId(payload.session_id);
      setImportProfile("standard");
      setCurrentScreen("review");
      pushToast({
        title: t("IMDF archive opened", "IMDFアーカイブを開きました"),
        description: t(`${payload.feature_count} features loaded.`, `${payload.feature_count} 件のフィーチャーを読み込みました。`),
        variant: "success"
      });
      navigate("/review");
    } catch (caught) {
      const message = handleApiError(caught, t("Failed to open IMDF archive", "IMDFアーカイブを開けませんでした"), {
        title: t("Open failed", "オープン失敗")
      });
      setImdfError(message);
    } finally {
      setImdfLoading(false);
    }
  };

  const runIllustratorConvert = async (file: File) => {
    setAiLoading(true);
    setAiError(null);
    setAiReport(null);
    try {
      const result = await convertIllustrator(file);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setAiReport(result.report);
      const layerCount = result.report ? Object.keys(result.report.layers).length : 0;
      const featureCount = result.report?.total_features ?? 0;
      pushToast({
        title: t("GeoPackage created", "GeoPackageを作成しました"),
        description: t(
          `${featureCount} shape(s) across ${layerCount} layer(s) — download started.`,
          `${layerCount} レイヤー・${featureCount} 図形をダウンロードしました。`
        ),
        variant: "success"
      });
    } catch (caught) {
      const message = handleApiError(caught, t("Conversion failed", "変換に失敗しました"), {
        title: t("Conversion failed", "変換失敗")
      });
      setAiError(message);
    } finally {
      setAiLoading(false);
    }
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
          ? await importImdfShapefiles(selectedFiles, setProgress)
          : await importShapefiles(selectedFiles, setProgress);
      setSessionExpiredMessage(null);
      setSessionId(payload.session_id);
      setImportProfile(payload.import_profile);
      setFiles(payload.files);
      setCleanupSummary(payload.cleanup_summary);
      setLastCleanup(payload.cleanup_summary);
      setCurrentScreen(payload.import_profile === "imdf_shapefile" ? "review" : "wizard");

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

      navigate(payload.import_profile === "imdf_shapefile" ? "/review" : "/wizard");
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

        <div className="mb-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className={[
              "rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm transition-colors",
              importMode === "standard"
                ? "border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)] text-[var(--color-primary)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
            ].join(" ")}
            onClick={() => setImportMode("standard")}
          >
            <span className="block font-medium">{t("Standard import", "標準インポート")}</span>
            <span className="mt-0.5 block text-xs opacity-80">
              {t("Classify and map source shapefiles in the wizard.", "ウィザードで元データを分類・マッピングします。")}
            </span>
          </button>
          <button
            type="button"
            className={[
              "rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm transition-colors",
              importMode === "imdf_shapefile"
                ? "border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)] text-[var(--color-primary)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
            ].join(" ")}
            onClick={() => setImportMode("imdf_shapefile")}
          >
            <span className="block font-medium">{t("IMDF-schema shapefiles", "IMDFスキーマのシェープファイル")}</span>
            <span className="mt-0.5 block text-xs opacity-80">
              {t("Open reviewed features directly and export Open Data Contest 2026 shapefiles.", "直接レビュー画面で開き、オープンデータコンテスト2026形式のシェープファイルを書き出します。")}
            </span>
          </button>
        </div>

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
                  ? importMode === "imdf_shapefile"
                    ? t("Import to Review", "レビューへインポート")
                    : t("Import & Continue", "インポートして次へ")
                  : importMode === "imdf_shapefile"
                    ? t("Import to Review", "レビューへインポート")
                    : t("Import & Continue", "インポートして次へ")}
            </span>
          </Button>
        </div>

        {/* IMDF re-open divider */}
        <div className="mt-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--color-border)]" />
          <span className="text-xs text-[var(--color-text-muted)]">{t("or", "または")}</span>
          <div className="h-px flex-1 bg-[var(--color-border)]" />
        </div>

        <div className="mt-4">
          <label className="block">
            <span className="sr-only">{t("Open IMDF archive", "IMDFアーカイブを開く")}</span>
            <input
              type="file"
              accept=".imdf,.zip"
              className="hidden"
              disabled={imdfLoading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void runImdfImport(file);
                e.target.value = "";
              }}
              id="imdf-file-input"
            />
            <Button
              variant="secondary"
              className="w-full"
              disabled={imdfLoading}
              onClick={() => document.getElementById("imdf-file-input")?.click()}
            >
              {imdfLoading
                ? t("Opening...", "開いています...")
                : t("Open IMDF archive", "IMDFアーカイブを開く")}
            </Button>
          </label>
          <p className="mt-1 text-center text-xs text-[var(--color-text-muted)]">
            {t("Re-open a previously exported .imdf.zip for further editing", "以前エクスポートした .imdf.zip を再編集のために開く")}
          </p>
          {imdfError ? (
            <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error-muted)] px-3 py-2 text-xs text-[var(--color-error)]">
              {imdfError}
            </div>
          ) : null}
        </div>

        {/* Illustrator (.ai) -> GeoPackage */}
        <div className="mt-4">
          <label className="block">
            <span className="sr-only">{t("Convert Illustrator file", "Illustratorファイルを変換")}</span>
            <input
              type="file"
              accept=".ai,.pdf"
              className="hidden"
              disabled={aiLoading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void runIllustratorConvert(file);
                e.target.value = "";
              }}
              id="illustrator-file-input"
            />
            <Button
              variant="secondary"
              className="w-full"
              disabled={aiLoading}
              onClick={() => document.getElementById("illustrator-file-input")?.click()}
            >
              {aiLoading
                ? t("Converting...", "変換中...")
                : t("Illustrator (.ai) → GeoPackage + QGIS", "Illustrator (.ai) → GeoPackage + QGIS")}
            </Button>
          </label>
          <p className="mt-1 text-center text-xs text-[var(--color-text-muted)]">
            {t(
              "Convert an .ai file's layers into a .gpkg plus a styled QGIS project (.qgs), downloaded as a .zip",
              ".ai のレイヤーを .gpkg とスタイル付き QGIS プロジェクト(.qgs)に変換し、.zip でダウンロード"
            )}
          </p>
          {aiReport ? (
            <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--color-success)]/20 bg-[var(--color-success-muted)] px-3 py-2 text-xs text-[var(--color-success)]">
              <p className="font-medium">
                {t(
                  `${aiReport.total_features} shape(s) in ${Object.keys(aiReport.layers).length} layer(s).`,
                  `${Object.keys(aiReport.layers).length} レイヤー・${aiReport.total_features} 図形。`
                )}
              </p>
              {aiReport.warnings.length > 0 ? (
                <p className="mt-0.5 opacity-80">
                  {t(`${aiReport.warnings.length} warning(s).`, `警告 ${aiReport.warnings.length} 件。`)}
                </p>
              ) : null}
            </div>
          ) : null}
          {aiError ? (
            <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error-muted)] px-3 py-2 text-xs text-[var(--color-error)]">
              {aiError}
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
