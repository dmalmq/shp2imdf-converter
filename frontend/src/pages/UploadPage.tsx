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
};

function toQueuedUploadFile(file: File): QueuedUploadFile {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2, 10)}`,
    file,
    selected: true
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
    setQueuedFiles((previous) => [...previous, ...acceptedFiles.map(toQueuedUploadFile)]);
    setError(null);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true
  });

  const selectedFiles = useMemo(
    () => queuedFiles.filter((item) => item.selected).map((item) => item.file),
    [queuedFiles]
  );
  const selectedFileCount = selectedFiles.length;

  const fileCountLabel = useMemo(() => {
    if (queuedFiles.length === 0) {
      return t("No files selected", "ファイルが選択されていません");
    }
    if (selectedFileCount === queuedFiles.length) {
      return t(`${queuedFiles.length} file(s) selected`, `${queuedFiles.length} 件のファイルを選択`);
    }
    return t(
      `${selectedFileCount} of ${queuedFiles.length} file(s) selected`,
      `${queuedFiles.length} 件中 ${selectedFileCount} 件を選択`
    );
  }, [queuedFiles.length, selectedFileCount, t]);

  const toggleQueuedFile = (id: string) => {
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
        "Select at least one shapefile component or zip before importing.",
        "インポート前に少なくとも1つのシェープファイル構成要素またはZIPを選択してください。"
      );
      setError(message);
      pushToast({
        title: t("No files selected", "ファイル未選択"),
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
        title: t("Import complete", "インポート完了"),
        description: t(`${payload.files.length} shapefile groups imported.`, `${payload.files.length} 件のグループをインポートしました。`),
        variant: "success"
      });
      if (payload.warnings.length > 0) {
        pushToast({
          title: t("Import warnings", "インポート警告"),
          description: t(
            `${payload.warnings.length} warning(s) reported during import.`,
            `${payload.warnings.length} 件の警告が報告されました。`
          ),
          variant: "info"
        });
      }
    } catch (caught) {
      const message = handleApiError(caught, t("Import failed", "インポートに失敗しました"), {
        title: t("Import failed", "インポート失敗")
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
      <h1 className="text-3xl font-semibold">SHP to IMDF Converter</h1>
      <p className="text-sm text-slate-600">
        {t(
          "Upload shapefile component files (.shp/.dbf/.shx/.prj) or a zip archive.",
          "シェープファイル構成要素(.shp/.dbf/.shx/.prj)またはZIPをアップロードしてください。"
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
          <p>{t("Drop files here...", "ここにファイルをドロップしてください...")}</p>
        ) : (
          <p>{t("Drag files/folders here, or click to browse.", "ここにファイル/フォルダをドラッグ、またはクリックで選択してください。")}</p>
        )}
      </section>

      <div className="rounded border bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{fileCountLabel}</p>
          {queuedFiles.length > 0 && !loading ? (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setAllQueuedFilesSelected(true)}
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                {t("Select all", "すべて選択")}
              </button>
              <button
                type="button"
                onClick={() => setAllQueuedFilesSelected(false)}
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                {t("Select none", "選択解除")}
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
        ) : queuedFiles.length > 0 ? (
          <ul className="mt-2 max-h-48 overflow-auto">
            {queuedFiles.map((item) => (
              <li key={item.id} className="py-0.5">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={item.selected}
                    onChange={() => toggleQueuedFile(item.id)}
                    className="h-4 w-4"
                  />
                  <span className={item.selected ? "text-slate-900" : "text-slate-500 line-through"}>{item.file.name}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={runImport}
          disabled={loading || selectedFileCount === 0}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
        >
          {loading ? t("Importing...", "インポート中...") : t("Import Files", "ファイルをインポート")}
        </button>
        {loading && <span className="text-sm text-slate-700">{t(`Upload progress: ${progress}%`, `アップロード進捗: ${progress}%`)}</span>}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {result && (
        <section className="rounded border bg-white p-4">
          <h2 className="text-lg font-semibold">{t("Cleanup Summary", "クリーンアップ概要")}</h2>
          <ul className="mt-2 text-sm">
            <li>{t("Multipolygons exploded", "マルチポリゴン分解数")}: {result.cleanup_summary.multipolygons_exploded}</li>
            <li>{t("Rings closed", "リング閉合数")}: {result.cleanup_summary.rings_closed}</li>
            <li>{t("Features reoriented", "向き補正数")}: {result.cleanup_summary.features_reoriented}</li>
            <li>{t("Empty features dropped", "空フィーチャ除外数")}: {result.cleanup_summary.empty_features_dropped}</li>
            <li>{t("Coordinates rounded", "座標丸め数")}: {result.cleanup_summary.coordinates_rounded}</li>
          </ul>
          <button
            type="button"
            onClick={continueToWizard}
            className="mt-4 rounded bg-emerald-600 px-4 py-2 text-white"
          >
            {t("Continue to Wizard", "ウィザードへ進む")}
          </button>
        </section>
      )}
    </main>
  );
}
