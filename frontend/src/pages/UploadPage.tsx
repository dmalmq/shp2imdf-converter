import { useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";

import { importShapefiles, type ImportResponse } from "../api/client";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { useToast } from "../components/shared/ToastProvider";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useAppStore } from "../store/useAppStore";

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
  const [result, setResult] = useState<ImportResponse | null>(null);

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
  const selectedArchiveCount = useMemo(
    () => archiveRows.filter((row) => row.selected).length,
    [archiveRows]
  );
  const selectedGeoPackageCount = useMemo(
    () => geoPackageRows.filter((row) => row.selected).length,
    [geoPackageRows]
  );

  const fileCountLabel = useMemo(() => {
    if (stemRows.length === 0 && geoPackageRows.length === 0 && archiveRows.length === 0) {
      return t("No files selected", "No files selected");
    }

    const parts: string[] = [];
    if (stemRows.length > 0) {
      parts.push(`${selectedStemCount} of ${stemRows.length} shapefile group(s) selected`);
    }
    if (geoPackageRows.length > 0) {
      parts.push(`${selectedGeoPackageCount} of ${geoPackageRows.length} GeoPackage(s) selected`);
    }
    if (archiveRows.length > 0) {
      parts.push(`${selectedArchiveCount} of ${archiveRows.length} archive(s) selected`);
    }

    const label = parts.join(" - ");
    return t(label, label);
  }, [
    archiveRows.length,
    geoPackageRows.length,
    selectedArchiveCount,
    selectedGeoPackageCount,
    selectedStemCount,
    stemRows.length,
    t
  ]);

  const componentCountLabel = useMemo(() => {
    const componentCount = queuedFiles.filter((item) => item.kind === "shapefile").length;
    const selectedComponentCount = queuedFiles.filter((item) => item.kind === "shapefile" && item.selected).length;
    if (componentCount === 0) {
      return null;
    }

    const label = `${selectedComponentCount} of ${componentCount} component file(s) selected`;
    return t(label, label);
  }, [queuedFiles, t]);

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

  const setAllQueuedFilesSelected = (selected: boolean) => {
    setQueuedFiles((previous) => previous.map((item) => (item.selected === selected ? item : { ...item, selected })));
  };

  const runImport = async () => {
    if (selectedFiles.length === 0) {
      const message = t(
        "Select at least one shapefile group, GeoPackage, or zip archive before importing.",
        "Select at least one shapefile group, GeoPackage, or zip archive before importing."
      );
      setError(message);
      pushToast({
        title: t("No files selected", "No files selected"),
        description: message,
        variant: "error"
      });
      return;
    }

    setLoading(true);
    setProgress(0);
    setError(null);
    try {
      const payload = await importShapefiles(selectedFiles, setProgress);
      setSessionExpiredMessage(null);
      setResult(payload);
      setSessionId(payload.session_id);
      setFiles(payload.files);
      setCleanupSummary(payload.cleanup_summary);
      setCurrentScreen("upload");
      pushToast({
        title: t("Import complete", "Import complete"),
        description: t(`${payload.files.length} dataset(s) imported.`, `${payload.files.length} dataset(s) imported.`),
        variant: "success"
      });
      if (payload.warnings.length > 0) {
        pushToast({
          title: t("Import warnings", "Import warnings"),
          description: t(
            `${payload.warnings.length} warning(s) reported during import.`,
            `${payload.warnings.length} warning(s) reported during import.`
          ),
          variant: "info"
        });
      }
    } catch (caught) {
      const message = handleApiError(caught, t("Import failed", "Import failed"), {
        title: t("Import failed", "Import failed")
      });
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const continueToWizard = () => {
    setCurrentScreen("wizard");
    navigate("/wizard");
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-semibold">SHP/GPKG to IMDF Converter</h1>
      <p className="text-sm text-slate-600">
        {t(
          "Upload shapefile component files (.shp/.dbf/.shx/.prj), GeoPackages (.gpkg), or a zip archive.",
          "Upload shapefile component files (.shp/.dbf/.shx/.prj), GeoPackages (.gpkg), or a zip archive."
        )}
      </p>

      <section
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed p-8 text-center ${
          isDragActive ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white"
        }`}
      >
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>{t("Drop files here...", "Drop files here...")}</p>
        ) : (
          <p>{t("Drag files/folders here, or click to browse.", "Drag files/folders here, or click to browse.")}</p>
        )}
      </section>

      <div className="rounded border bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-medium">{fileCountLabel}</p>
            {componentCountLabel ? <p className="text-xs text-slate-500">{componentCountLabel}</p> : null}
          </div>
          {queuedFiles.length > 0 && !loading ? (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setAllQueuedFilesSelected(true)}
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                {t("Select all", "Select all")}
              </button>
              <button
                type="button"
                onClick={() => setAllQueuedFilesSelected(false)}
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                {t("Select none", "Select none")}
              </button>
            </div>
          ) : null}
        </div>

        {loading ? (
          <div className="mt-2 space-y-2">
            <SkeletonBlock className="h-3 w-full" />
            <SkeletonBlock className="h-3 w-11/12" />
            <SkeletonBlock className="h-3 w-4/5" />
          </div>
        ) : stemRows.length > 0 || geoPackageRows.length > 0 || archiveRows.length > 0 ? (
          <div className="mt-3 max-h-[560px] overflow-auto pr-1">
            {groupedStemRows.map((group) => (
              <section key={group.suffixGroup} className="mb-4 last:mb-0">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.suffixGroup}</h3>
                <ul className="space-y-1">
                  {group.rows.map((row) => (
                    <li key={row.key}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={() => toggleStemGroup(row.key)}
                          className="h-4 w-4"
                        />
                        <span className={row.selected ? "text-slate-900" : "text-slate-500 line-through"}>{row.stem}</span>
                        <span className="text-xs text-slate-500">
                          ({row.fileCount} file(s): {row.extensions.map((extension) => `.${extension}`).join(", ")})
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {geoPackageRows.length > 0 ? (
              <section className="mb-4">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">GeoPackage</h3>
                <ul className="space-y-1">
                  {geoPackageRows.map((item) => (
                    <li key={item.id}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.selected}
                          onChange={() => toggleGeoPackage(item.id)}
                          className="h-4 w-4"
                        />
                        <span className={item.selected ? "text-slate-900" : "text-slate-500 line-through"}>
                          {item.file.name}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {archiveRows.length > 0 ? (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">ZIP</h3>
                <ul className="space-y-1">
                  {archiveRows.map((item) => (
                    <li key={item.id}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.selected}
                          onChange={() => toggleArchive(item.id)}
                          className="h-4 w-4"
                        />
                        <span className={item.selected ? "text-slate-900" : "text-slate-500 line-through"}>{item.file.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={runImport}
          disabled={loading || selectedFileCount === 0}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
        >
          {loading ? t("Importing...", "Importing...") : t("Import Files", "Import Files")}
        </button>
        {loading && <span className="text-sm text-slate-700">{t(`Upload progress: ${progress}%`, `Upload progress: ${progress}%`)}</span>}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {result && (
        <section className="rounded border bg-white p-4">
          <h2 className="text-lg font-semibold">{t("Cleanup Summary", "Cleanup Summary")}</h2>
          <ul className="mt-2 text-sm">
            <li>{t("Multipolygons exploded", "Multipolygons exploded")}: {result.cleanup_summary.multipolygons_exploded}</li>
            <li>{t("Rings closed", "Rings closed")}: {result.cleanup_summary.rings_closed}</li>
            <li>{t("Features reoriented", "Features reoriented")}: {result.cleanup_summary.features_reoriented}</li>
            <li>{t("Empty features dropped", "Empty features dropped")}: {result.cleanup_summary.empty_features_dropped}</li>
            <li>{t("Coordinates rounded", "Coordinates rounded")}: {result.cleanup_summary.coordinates_rounded}</li>
          </ul>
          <button
            type="button"
            onClick={continueToWizard}
            className="mt-4 rounded bg-emerald-600 px-4 py-2 text-white"
          >
            {t("Continue to Wizard", "Continue to Wizard")}
          </button>
        </section>
      )}
    </main>
  );
}
