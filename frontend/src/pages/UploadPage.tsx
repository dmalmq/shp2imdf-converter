import { useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useNavigate } from "react-router-dom";

import { ImportResponse, importShapefiles } from "../api/client";
import { useAppStore } from "../store/useAppStore";


export function UploadPage() {
  const navigate = useNavigate();
  const setSessionId = useAppStore((state) => state.setSessionId);
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);

  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);

  const onDrop = (acceptedFiles: File[]) => {
    setQueuedFiles((previous) => [...previous, ...acceptedFiles]);
    setError(null);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true
  });

  const fileCountLabel = useMemo(() => {
    if (queuedFiles.length === 0) {
      return "No files selected";
    }
    return `${queuedFiles.length} file(s) selected`;
  }, [queuedFiles.length]);

  const runImport = async () => {
    if (queuedFiles.length === 0) {
      setError("Select shapefile components or a zip before importing.");
      return;
    }
    setLoading(true);
    setProgress(0);
    setError(null);
    try {
      const payload = await importShapefiles(queuedFiles, setProgress);
      setResult(payload);
      setSessionId(payload.session_id);
      setCurrentScreen("upload");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Import failed";
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
        Upload shapefile component files (.shp/.dbf/.shx/.prj) or a zip archive.
      </p>

      <section
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed p-8 text-center ${
          isDragActive ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white"
        }`}
      >
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>Drop files here...</p>
        ) : (
          <p>Drag files/folders here, or click to browse.</p>
        )}
      </section>

      <div className="rounded border bg-white p-4 text-sm">
        <p className="font-medium">{fileCountLabel}</p>
        {queuedFiles.length > 0 && (
          <ul className="mt-2 max-h-36 overflow-auto">
            {queuedFiles.map((file) => (
              <li key={`${file.name}-${file.lastModified}`}>{file.name}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={runImport}
          disabled={loading}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
        >
          {loading ? "Importing..." : "Import Files"}
        </button>
        {loading && <span className="text-sm text-slate-700">Upload progress: {progress}%</span>}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {result && (
        <section className="rounded border bg-white p-4">
          <h2 className="text-lg font-semibold">Cleanup Summary</h2>
          <ul className="mt-2 text-sm">
            <li>Multipolygons exploded: {result.cleanup_summary.multipolygons_exploded}</li>
            <li>Rings closed: {result.cleanup_summary.rings_closed}</li>
            <li>Features reoriented: {result.cleanup_summary.features_reoriented}</li>
            <li>Empty features dropped: {result.cleanup_summary.empty_features_dropped}</li>
            <li>Coordinates rounded: {result.cleanup_summary.coordinates_rounded}</li>
          </ul>
          <button
            type="button"
            onClick={continueToWizard}
            className="mt-4 rounded bg-emerald-600 px-4 py-2 text-white"
          >
            Continue to Wizard
          </button>
        </section>
      )}
    </main>
  );
}

