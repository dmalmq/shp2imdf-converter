import { useMemo, useReducer, useState } from "react";

import {
  assignFloors,
  exportIllustrator,
  previewIllustrator,
  type AssignFloorsResponse,
  type ExportFormatsPayload,
  type IllustratorPreviewResponse
} from "../api/client";
import { AssignmentPanel } from "../components/illustrator/AssignmentPanel";
import { ControlPointList } from "../components/illustrator/ControlPointList";
import { PageAssignmentPanel } from "../components/illustrator/PageAssignmentPanel";
import {
  FLOOR_TINTS,
  type FloorLayer,
  type ReferenceLayer
} from "../components/illustrator/PlacementMap";
import { PlacementLibrary } from "../components/illustrator/PlacementLibrary";
import { PlacementMap } from "../components/illustrator/PlacementMap";
import { ReferenceLayerList } from "../components/illustrator/ReferenceLayerList";
import { TransformPanel } from "../components/illustrator/TransformPanel";
import { Button, Card } from "../components/ui";
import { siteNameFromFilename } from "../lib/siteName";
import { partitionByFloors, type PartitionFloor } from "../lib/svgPreview";
import {
  DEFAULT_METRES_PER_POINT,
  initialPlacementHistory,
  placementHistoryReducer,
  toFloorPayloads,
  type PlacementState
} from "../hooks/useIllustratorPlacement";
import { usePlacementShortcuts } from "../hooks/usePlacementShortcuts";
import { useUiLanguage } from "../hooks/useUiLanguage";

const CRS_CHOICES = (suggested: string, suggestedLabel: string) => [
  { value: suggested, label: suggestedLabel },
  { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
];

type AssignedRegion = {
  label: string;
  box: [number, number, number, number] | null;
  pages: number[] | null;
  layer_names: string[] | null;
};

/** Union of the given pages' content bounds, or null when none are known. */
function pageUnionBounds(
  preview: IllustratorPreviewResponse,
  pages: number[] | null
): [number, number, number, number] | null {
  if (!pages || pages.length === 0) return null;
  let union: [number, number, number, number] | null = null;
  for (const page of preview.pages) {
    if (!pages.includes(page.index)) continue;
    const [minx, miny, maxx, maxy] = page.bounds;
    union = union
      ? [
          Math.min(union[0], minx),
          Math.min(union[1], miny),
          Math.max(union[2], maxx),
          Math.max(union[3], maxy)
        ]
      : [minx, miny, maxx, maxy];
  }
  return union;
}

/**
 * Each floor's placement bounds: the server's per-floor artwork bounds when
 * the assign summary has them (exact for page floors, tighter than the drawn
 * box for box floors), else the drawn box, else the union of the region's
 * pages, else the whole artwork.
 */
function boundsFor(
  preview: IllustratorPreviewResponse,
  region: AssignedRegion,
  summary?: AssignFloorsResponse
): [number, number, number, number] {
  return (
    summary?.floors.find((floor) => floor.label === region.label)?.artwork_bounds ??
    region.box ??
    pageUnionBounds(preview, region.pages) ??
    preview.artwork_bounds
  );
}

function initialStateFromAssignment(
  preview: IllustratorPreviewResponse,
  assignment: AssignedRegion[],
  summary?: AssignFloorsResponse
): PlacementState {
  const regions: AssignedRegion[] = assignment.length
    ? assignment
    : [{ label: "artwork", box: preview.artwork_bounds, pages: null, layer_names: null }];
  const first = regions[0];
  // The server already computed each floor's bounds from the geometry it
  // matched, which is exact for page floors (no box) and tighter than the
  // drawn box for box floors.
  return {
    frame: {
      rotationDeg: 0,
      metresPerPoint: DEFAULT_METRES_PER_POINT,
      workingCrs: preview.suggested_crs
    },
    activeFloorLabel: first.label,
    scaleLocked: false,
    floors: regions.map((region) => {
      const bounds = boundsFor(preview, region, summary);
      return {
        label: region.label,
        linked: true,
        artworkAnchor: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        mapAnchor: [139.7671, 35.6812],
        controlPoints: [],
        artworkBounds: bounds
      };
    })
  };
}

const DEFAULT_STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
  activeFloorLabel: "artwork",
  scaleLocked: false,
  floors: [
    {
      label: "artwork",
      linked: true,
      artworkAnchor: [50, 50],
      mapAnchor: [139.7671, 35.6812],
      controlPoints: [],
      artworkBounds: [0, 0, 100, 100]
    }
  ]
};

export function IllustratorPage() {
  const { t } = useUiLanguage();
  const [preview, setPreview] = useState<IllustratorPreviewResponse | null>(null);
  const [assignment, setAssignment] = useState<AssignedRegion[] | null>(null);
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
  const [history, dispatch] = useReducer(
    placementHistoryReducer,
    DEFAULT_STATE,
    initialPlacementHistory
  );
  const state = history.present;
  const [recenterTo, setRecenterTo] = useState<[number, number] | null>(null);
  const [referenceLayers, setReferenceLayers] = useState<ReferenceLayer[]>([]);

  // Only on the placement view: the upload and assignment screens have their own
  // keyboard behaviour and no floor to nudge.
  usePlacementShortcuts({
    state,
    dispatch,
    enabled: Boolean(preview) && assignment !== null,
    onEscape: () => setPicking(false)
  });

  // Computed unconditionally so the hook order is stable across the early
  // returns below (a conditional hook here crashes the placement view).
  const bounds: [number, number, number, number] =
    preview?.artwork_bounds ?? ([0, 0, 100, 100] as [number, number, number, number]);

  // Drawings are named after the building (e.g. 0307_大井町.ai), so the panel can
  // search for it and open the map on the right place instead of a city centre.
  const siteName = siteNameFromFilename(preview?.report?.source_name ?? "");

  const floorLayers: FloorLayer[] = useMemo(() => {
    if (!preview) return [];
    const regions: AssignedRegion[] = (assignment ?? []).length
      ? (assignment as AssignedRegion[])
      : [{ label: "artwork", box: preview.artwork_bounds, pages: null, layer_names: null }];
    const { perFloor } = partitionByFloors(
      preview.preview,
      regions.map((region) => ({
        label: region.label,
        box: region.box,
        pages: region.pages,
        layerNames: region.layer_names
      }))
    );
    return regions.map((region, index) => ({
      label: region.label,
      features: perFloor.get(region.label) ?? [],
      bounds: boundsFor(preview, region),
      color: FLOOR_TINTS[index % FLOOR_TINTS.length]
    }));
  }, [preview, assignment]);

  const convert = async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const response = await previewIllustrator(file);
      setPreview(response);
      setAssignment(null);
      setRecenterTo(null);
      setLastFile(file);
      setOutputCrs(response.suggested_crs);
      // The state carries scaleLocked: false already, so no unlockScale follow-up.
      dispatch({ type: "resetPlacement", state: initialStateFromAssignment(response, []) });
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

  if (assignment === null) {
    const commitAssignment = async (floors: PartitionFloor[]) => {
      const regions: AssignedRegion[] = floors.map((floor) => ({
        label: floor.label,
        box: floor.box,
        pages: floor.pages,
        layer_names: floor.layerNames
      }));
      try {
        const summary = await assignFloors(preview.conversion_id, regions);
        setAssignment(regions);
        dispatch({
          type: "resetPlacement",
          state: initialStateFromAssignment(preview, regions, summary)
        });
      } catch {
        setError(
          t(
            "Could not save the floor assignment.",
            "フロア割り当てを保存できませんでした。"
          )
        );
      }
    };

    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <Card padding="lg" className="w-full max-w-4xl">
          <h1 className="text-lg font-semibold">
            {t("Assign floors", "フロアを割り当て")}
          </h1>
          {preview.pages.length > 1 ? (
            <PageAssignmentPanel
              preview={preview.preview}
              pages={preview.pages}
              layerSummaries={preview.layers}
              onSkip={() => setAssignment([])}
              onAssigned={commitAssignment}
            />
          ) : (
            <AssignmentPanel
              preview={preview.preview}
              artworkBounds={preview.artwork_bounds}
              layerSummaries={preview.layers}
              onSkip={() => setAssignment([])}
              onAssigned={commitAssignment}
            />
          )}
          {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
      <div className="flex w-80 shrink-0 flex-col gap-4 overflow-auto">
        <Card padding="md">
          <TransformPanel
            state={state}
            dispatch={dispatch}
            siteName={siteName}
            onLocate={setRecenterTo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
          />
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
          <ReferenceLayerList layers={referenceLayers} onChange={setReferenceLayers} />
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

      <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border">
        <PlacementMap
          floors={floorLayers}
          state={state}
          dispatch={dispatch}
          recenterTo={recenterTo}
          referenceLayers={referenceLayers}
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
