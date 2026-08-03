import { useReducer, useState } from "react";

import {
  exportIllustrator,
  previewIllustrator,
  type ExportFormatsPayload,
  type IllustratorPreviewResponse
} from "../api/client";
import { ControlPointList } from "../components/illustrator/ControlPointList";
import { PlacementLibrary } from "../components/illustrator/PlacementLibrary";
import { PlacementMap } from "../components/illustrator/PlacementMap";
import { TransformPanel } from "../components/illustrator/TransformPanel";
import { Button, Card } from "../components/ui";
import {
  placementReducer,
  toFloorPayloads,
  type PlacementState
} from "../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../hooks/useUiLanguage";

const CRS_CHOICES = (suggested: string, suggestedLabel: string) => [
  { value: suggested, label: suggestedLabel },
  { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
];

function initialState(preview: IllustratorPreviewResponse): PlacementState {
  const [minX, minY, maxX, maxY] = preview.artwork_bounds;
  return {
    frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: preview.suggested_crs },
    activeFloorLabel: "artwork",
    scaleLocked: false,
    floors: [
      {
        label: "artwork",
        linked: true,
        // The anchor is set once, at the artwork centre, and never recomputed.
        artworkAnchor: [(minX + maxX) / 2, (minY + maxY) / 2],
        mapAnchor: [139.7671, 35.6812],
        controlPoints: [],
        artworkBounds: [minX, minY, maxX, maxY]
      }
    ]
  };
}

const DEFAULT_STATE: PlacementState = initialState({
  artwork_bounds: [0, 0, 100, 100],
  suggested_crs: "EPSG:6677"
} as IllustratorPreviewResponse);

export function IllustratorPage() {
  const { t } = useUiLanguage();
  const [preview, setPreview] = useState<IllustratorPreviewResponse | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [outputCrs, setOutputCrs] = useState("EPSG:4326");
  const [formats, setFormats] = useState<ExportFormatsPayload>({
    geopackage: true,
    shapefile: true,
    qgis: true
  });
  const [state, dispatch] = useReducer(placementReducer, DEFAULT_STATE);

  const convert = async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const response = await previewIllustrator(file);
      setPreview(response);
      setLastFile(file);
      setOutputCrs(response.suggested_crs);
      const fresh = initialState(response);
      dispatch({ type: "applyFloors", floors: toFloorPayloads(fresh) });
      dispatch({ type: "unlockScale" });
    } catch {
      setError(
        t(
          "Could not read that file. Re-save the .ai with 'Create PDF Compatible File' enabled.",
          "ファイルを読み込めません。「PDF互換ファイルを作成」を有効にして保存し直してください。"
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const download = async () => {
    if (!preview) return;
    setError(null);
    try {
      const result = await exportIllustrator(preview.conversion_id, {
        floors: toFloorPayloads(state),
        output_crs: outputCrs,
        formats
      });
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      // The cache may have expired; the browser still holds the file.
      setError(
        t(
          "The conversion expired. Convert the file again.",
          "変換の有効期限が切れました。もう一度変換してください。"
        )
      );
      if (lastFile) void convert(lastFile);
    }
  };

  if (!preview) {
    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <Card padding="lg" className="w-full max-w-2xl">
          <h1 className="text-lg font-semibold">
            {t("Place Illustrator artwork", "Illustrator図面の配置")}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {t(
              "Convert an .ai file, position it on the map, then export georeferenced files.",
              ".ai を変換し、地図上に配置してから、座標付きファイルを書き出します。"
            )}
          </p>
          <input
            type="file"
            accept=".ai,.pdf"
            className="hidden"
            id="illustrator-georef-input"
            disabled={loading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void convert(file);
              event.target.value = "";
            }}
          />
          <Button
            className="mt-4 w-full"
            disabled={loading}
            onClick={() => document.getElementById("illustrator-georef-input")?.click()}
          >
            {loading ? t("Converting...", "変換中...") : t("Choose .ai file", ".ai を選択")}
          </Button>
          {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
        </Card>
      </div>
    );
  }

  const bounds = preview.artwork_bounds;

  return (
    <div className="flex flex-1 gap-4 p-4">
      <div className="w-80 shrink-0 space-y-4 overflow-auto">
        <Card padding="md">
          <TransformPanel state={state} dispatch={dispatch} />
        </Card>
        <Card padding="md">
          <ControlPointList
            state={state}
            dispatch={dispatch}
            picking={picking}
            onTogglePicking={() => setPicking((value) => !value)}
          />
        </Card>
        <Card padding="md">
          <PlacementLibrary state={state} dispatch={dispatch} artworkBounds={bounds} />
        </Card>
        <Card padding="md">
          <span className="text-xs font-medium">{t("Export", "書き出し")}</span>
          <select
            className="mt-1 w-full rounded-[var(--radius-md)] border px-2 py-1 text-sm"
            value={outputCrs}
            onChange={(event) => setOutputCrs(event.target.value)}
          >
            {CRS_CHOICES(preview.suggested_crs, preview.suggested_crs_label).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {(["geopackage", "shapefile", "qgis"] as const).map((key) => (
            <label key={key} className="mt-1 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={formats[key]}
                onChange={(event) => setFormats({ ...formats, [key]: event.target.checked })}
              />
              {key}
            </label>
          ))}
          <Button className="mt-2 w-full" onClick={() => void download()}>
            {t("Export", "書き出し")}
          </Button>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {t(
              `Preview shows ${preview.preview_features} of ${preview.total_features} shapes.`,
              `プレビューは ${preview.total_features} 図形中 ${preview.preview_features} 件を表示。`
            )}
          </p>
          {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
        </Card>
      </div>

      <div className="min-h-[600px] flex-1 overflow-hidden rounded-[var(--radius-md)] border">
        <PlacementMap
          preview={preview.preview}
          artworkBounds={bounds}
          state={state}
          dispatch={dispatch}
          pickingControlPoint={picking}
          onPickMap={(lngLat) => {
            dispatch({
              type: "addControlPoint",
              point: {
                id: `${Date.now()}`,
                artwork:
                  state.floors.find((f) => f.label === state.activeFloorLabel)?.artworkAnchor ?? [0, 0],
                map: lngLat
              }
            });
            setPicking(false);
          }}
        />
      </div>
    </div>
  );
}
