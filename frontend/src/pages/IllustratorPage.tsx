import { useEffect, useMemo, useReducer, useState } from "react";

import {
  assignFloors,
  exportIllustrator,
  matchIllustratorRegions,
  matchIllustratorShape,
  previewIllustrator,
  type AssignFloorsResponse,
  type ExportFormatsPayload,
  type IllustratorPreviewResponse,
  type ArtworkRegion,
  type IllustratorShapeMatchSuggestion
} from "../api/client";
import { isApiClientError, isBackendUnreachableError, toErrorMessage } from "../api/errors";
import { AssignmentPanel } from "../components/illustrator/AssignmentPanel";
import { PageAssignmentPanel } from "../components/illustrator/PageAssignmentPanel";
import {
  FLOOR_TINTS,
  type ArtworkShapeSelection,
  type FloorLayer,
  type ReferenceLayer
} from "../components/illustrator/PlacementMap";
import { PlacementMap } from "../components/illustrator/PlacementMap";
import { PlacementSidebar, type PlacementTab } from "../components/illustrator/PlacementSidebar";
import { nextMatchTarget } from "../components/illustrator/ReferenceLayerList";
import {
  parseMatchTarget,
  type ShapeMatchPanelModel
} from "../components/illustrator/ShapeMatchPanel";
import { Button, Card } from "../components/ui";
import { siteNameFromFilename } from "../lib/siteName";
import { partitionByFloors, type PartitionFloor } from "../lib/svgPreview";
import {
  DEFAULT_METRES_PER_POINT,
  MIN_CONTROL_POINTS,
  initialPlacementHistory,
  placedBoundsWgs84,
  placementHistoryReducer,
  resolvedTransform,
  toFloorPayloads,
  type AdjustmentMode,
  type PlacementState
} from "../hooks/useIllustratorPlacement";
import { usePlacementShortcuts } from "../hooks/usePlacementShortcuts";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  artworkFromLngLat,
  artworkToLngLat,
  type SimilarityTransform
} from "../lib/similarity";

type AssignedRegion = {
  label: string;
  box: [number, number, number, number] | null;
  pages: number[] | null;
  layer_names: string[] | null;
};

type PickSession = {
  stage: "artwork" | "map";
  pendingArtwork: [number, number] | null;
  floorLabel: string;
  mode: AdjustmentMode;
};

type ShapeMatchState = {
  referenceName: string;
  referenceFloorLabel: string;
  selecting: boolean;
  selection: ArtworkShapeSelection | null;
  matches: IllustratorShapeMatchSuggestion[];
  previewRank: number | null;
  loading: boolean;
  searched: boolean;
  error: string | null;
  /** The floor the source area belongs to, and the only floor an apply moves. */
  sourceFloorLabel: string;
  regionStage: "source" | "target" | null;
  sourceRegion: ArtworkRegion | null;
  targetRegion: ArtworkRegion | null;
};

const EMPTY_SHAPE_MATCH: ShapeMatchState = {
  referenceName: "",
  referenceFloorLabel: "",
  selecting: false,
  selection: null,
  matches: [],
  previewRank: null,
  loading: false,
  searched: false,
  error: null,
  sourceFloorLabel: "",
  regionStage: null,
  sourceRegion: null,
  targetRegion: null,
};

function transformPayload(transform: SimilarityTransform) {
  return {
    artwork_anchor: transform.artworkAnchor,
    map_anchor: transform.mapAnchor,
    rotation_deg: transform.rotationDeg,
    metres_per_point: transform.metresPerPoint,
    working_crs: transform.workingCrs
  };
}

/** The drawn corners as that floor's own artwork box, so it tracks the floor. */
function artworkRegion(
  transform: SimilarityTransform,
  corners: [number, number][]
): ArtworkRegion {
  const points = corners.map((corner) => artworkFromLngLat(transform, corner));
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function regionCorners(
  transform: SimilarityTransform,
  region: ArtworkRegion
): [number, number][] {
  const [minX, minY, maxX, maxY] = region;
  return [
    artworkToLngLat(transform, minX, maxY),
    artworkToLngLat(transform, maxX, maxY),
    artworkToLngLat(transform, maxX, minY),
    artworkToLngLat(transform, minX, minY)
  ];
}

function keptMatchTarget(current: Pick<ShapeMatchState, "referenceName" | "referenceFloorLabel">): ShapeMatchState {
  return {
    ...EMPTY_SHAPE_MATCH,
    referenceName: current.referenceName,
    referenceFloorLabel: current.referenceFloorLabel
  };
}

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
  const [pickSession, setPickSession] = useState<PickSession | null>(null);
  const [shapeMatch, setShapeMatch] = useState<ShapeMatchState>(EMPTY_SHAPE_MATCH);
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
  const [placementTab, setPlacementTab] = useState<PlacementTab>("fit");
  // Floors start grouped: the whole building is aligned first, then the user
  // switches to individual mode for final per-floor nudges. UI-level only —
  // never an undo step.
  const [adjustmentMode, setAdjustmentMode] = useState<AdjustmentMode>("group");

  // Only on the placement view: the upload and assignment screens have their own
  // keyboard behaviour and no floor to nudge.
  usePlacementShortcuts({
    state,
    dispatch,
    mode: adjustmentMode,
    enabled: Boolean(preview) && assignment !== null,
    onEscape: () => {
      setPickSession(null);
      setShapeMatch((current) => ({ ...current, selecting: false, previewRank: null }));
    }
  });

  useEffect(() => {
    setPickSession(null);
    setShapeMatch((current) => {
      // Switching levels is how the user gets a clear look at the floor being
      // boxed, so an area pick has to survive it. Only the outline selection,
      // which belongs to one floor, is discarded.
      if (current.regionStage || current.sourceRegion || current.targetRegion) {
        return { ...current, selecting: false, selection: null };
      }
      return {
        ...EMPTY_SHAPE_MATCH,
        ...nextMatchTarget(
          referenceLayers,
          state.floors.map((floor) => floor.label),
          state.activeFloorLabel,
          current
        )
      };
    });
  }, [state.activeFloorLabel, adjustmentMode]);

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

  // Reference uploads are trimmed to ~1 km around the placed artwork; the box
  // comes from the same transforms that place the floors on the map, so the
  // trim follows every drag, rotate and scale.
  const focusBounds = useMemo(
    () =>
      placedBoundsWgs84(
        state,
        floorLayers.map((floor) => ({ label: floor.label, bounds: floor.bounds }))
      ),
    [state, floorLayers]
  );

  const referenceFloorPlacement =
    state.floors.find((floor) => floor.label === shapeMatch.referenceFloorLabel) ?? null;
  const sourceFloorPlacement =
    state.floors.find((floor) => floor.label === shapeMatch.sourceFloorLabel) ?? null;

  const previewSuggestion =
    shapeMatch.matches.find((match) => match.rank === shapeMatch.previewRank) ?? null;
  const shapeMatchPreview = previewSuggestion
    ? {
        suggestion: previewSuggestion,
        transform: {
          artworkAnchor: previewSuggestion.transform.artwork_anchor,
          mapAnchor: previewSuggestion.transform.map_anchor,
          rotationDeg: previewSuggestion.transform.rotation_deg,
          metresPerPoint: previewSuggestion.transform.metres_per_point,
          workingCrs: previewSuggestion.transform.working_crs
        } satisfies SimilarityTransform
      }
    : null;

  /**
   * The API explains its own failures far better than this screen can guess, so
   * prefer its message and keep the local string as the last resort. An
   * unreachable backend is the one case worth rewording: it used to surface as
   * "re-save the .ai", which blames a file that is fine.
   */
  const describeFailure = (error: unknown, fallback: string): string =>
    isBackendUnreachableError(error)
      ? t(
          "Could not reach the converter. The server may be down or restarting - check it is running, then try again.",
          "コンバーターに接続できません。サーバーが停止または再起動中の可能性があります。稼働状況を確認してから、もう一度お試しください。"
        )
      : toErrorMessage(error, fallback);

  const updateReferenceLayers = (layers: ReferenceLayer[]) => {
    setReferenceLayers(layers);
    setShapeMatch((current) => {
      const next = nextMatchTarget(
        layers,
        state.floors.map((floor) => floor.label),
        state.activeFloorLabel,
        current
      );
      return next.referenceName === current.referenceName &&
        next.referenceFloorLabel === current.referenceFloorLabel
        ? current
        : {
            ...current,
            ...next,
            matches: [],
            previewRank: null,
            searched: false,
            error: null
          };
    });
  };

  const findShapeMatches = async () => {
    const selection = shapeMatch.selection;
    const reference = referenceLayers.find((layer) => layer.name === shapeMatch.referenceName);
    const referenceFloor = state.floors.find(
      (floor) => floor.label === shapeMatch.referenceFloorLabel
    );
    const active = state.floors.find((floor) => floor.label === state.activeFloorLabel);
    if (!preview || !active) return;

    // Two areas the user asserted are the same thing beat a single outline.
    // They are anchored to the floor that was active when picking started, not
    // to whichever floor the user is currently looking at.
    if (
      referenceFloor &&
      sourceFloorPlacement &&
      shapeMatch.sourceRegion &&
      shapeMatch.targetRegion
    ) {
      void findRegionMatches(sourceFloorPlacement, referenceFloor);
      return;
    }
    if (
      !selection ||
      selection.floorLabel !== active.label ||
      (!reference && !referenceFloor)
    ) {
      return;
    }

    setShapeMatch((current) => ({ ...current, loading: true, searched: false, error: null }));
    const currentTransform = resolvedTransform(state, active);
    try {
      const response = await matchIllustratorShape(preview.conversion_id, {
        floor_label: active.label,
        artwork: {
          source_table: selection.sourceTable,
          source_row: selection.sourceRow
        },
        current_transform: transformPayload(currentTransform),
        scale_locked: adjustmentMode === "group" && state.scaleLocked,
        ...(referenceFloor
          ? {
              reference_floor: {
                label: referenceFloor.label,
                transform: transformPayload(resolvedTransform(state, referenceFloor))
              }
            }
          : { reference: reference!.data })
      });
      setShapeMatch((current) =>
        current.selection?.floorLabel === selection.floorLabel &&
        current.selection.sourceTable === selection.sourceTable &&
        current.selection.sourceRow === selection.sourceRow &&
        (referenceFloor
          ? current.referenceFloorLabel === referenceFloor.label
          : current.referenceName === reference?.name)
          ? {
              ...current,
              matches: response.matches,
              previewRank: response.matches[0]?.rank ?? null,
              loading: false,
              searched: true,
              error: null
            }
          : current
      );
    } catch (error) {
      setShapeMatch((current) =>
        current.selection?.floorLabel === selection.floorLabel &&
        current.selection.sourceTable === selection.sourceTable &&
        current.selection.sourceRow === selection.sourceRow &&
        (referenceFloor
          ? current.referenceFloorLabel === referenceFloor.label
          : current.referenceName === reference?.name)
          ? {
              ...current,
              loading: false,
              searched: true,
              error: describeFailure(
                error,
                t(
                  "Could not compare that outline with the selected target.",
                  "選択した外周と照合対象を比較できませんでした。"
                )
              )
            }
          : current
      );
    }
  };

  const findRegionMatches = async (
    sourceFloor: PlacementState["floors"][number],
    referenceFloor: PlacementState["floors"][number]
  ) => {
    const sourceRegion = shapeMatch.sourceRegion;
    const targetRegion = shapeMatch.targetRegion;
    if (!preview || !sourceRegion || !targetRegion) return;

    setShapeMatch((current) => ({ ...current, loading: true, searched: false, error: null }));
    try {
      const response = await matchIllustratorRegions(preview.conversion_id, {
        floor_label: sourceFloor.label,
        region: sourceRegion,
        current_transform: transformPayload(resolvedTransform(state, sourceFloor)),
        // The result is applied to this floor alone, and an individual apply
        // ignores the scale lock, so constraining the fit would only reject
        // correspondences the two areas actually agree on.
        scale_locked: false,
        reference_floor: {
          label: referenceFloor.label,
          transform: transformPayload(resolvedTransform(state, referenceFloor)),
          region: targetRegion
        }
      });
      setShapeMatch((current) =>
        current.sourceRegion === sourceRegion && current.targetRegion === targetRegion
          ? {
              ...current,
              matches: response.matches,
              previewRank: response.matches[0]?.rank ?? null,
              loading: false,
              searched: true,
              error: null
            }
          : current
      );
    } catch (error) {
      setShapeMatch((current) =>
        current.sourceRegion === sourceRegion && current.targetRegion === targetRegion
          ? {
              ...current,
              loading: false,
              searched: true,
              error: describeFailure(
                error,
                t(
                  "Could not compare those two areas.",
                  "選択した2つの範囲を比較できませんでした。"
                )
              )
            }
          : current
      );
    }
  };

  const shapeMatchModel: ShapeMatchPanelModel = {
    referenceName: shapeMatch.referenceName,
    referenceFloorLabel: shapeMatch.referenceFloorLabel,
    selecting: shapeMatch.selecting,
    selection: shapeMatch.selection,
    matches: shapeMatch.matches,
    previewRank: shapeMatch.previewRank,
    loading: shapeMatch.loading,
    searched: shapeMatch.searched,
    error: shapeMatch.error,
    sourceFloorLabel: shapeMatch.sourceFloorLabel || state.activeFloorLabel || "",
    regionStage: shapeMatch.regionStage,
    hasSourceRegion: shapeMatch.sourceRegion !== null,
    hasTargetRegion: shapeMatch.targetRegion !== null,
    onReferenceChange: (referenceName) =>
      setShapeMatch((current) => ({
        ...current,
        referenceName,
        referenceFloorLabel: "",
        matches: [],
        previewRank: null,
        searched: false,
        error: null
      })),
    onMatchTargetChange: (target) =>
      setShapeMatch((current) => ({
        ...current,
        ...parseMatchTarget(target),
        matches: [],
        previewRank: null,
        searched: false,
        error: null
      })),
    onToggleSelection: () => {
      setPickSession(null);
      setShapeMatch((current) =>
        current.selecting
          ? { ...current, selecting: false }
          : {
              ...current,
              selecting: true,
              selection: null,
              matches: [],
              previewRank: null,
              searched: false,
              error: null
            }
      );
    },
    onToggleRegions: () => {
      setPickSession(null);
      setShapeMatch((current) =>
        current.regionStage
          ? { ...current, regionStage: null }
          : {
              ...current,
              sourceFloorLabel: state.activeFloorLabel ?? "",
              regionStage: "source",
              selecting: false,
              selection: null,
              sourceRegion: null,
              targetRegion: null,
              matches: [],
              previewRank: null,
              searched: false,
              error: null
            }
      );
    },
    onFind: () => void findShapeMatches(),
    onPreview: (previewRank) => setShapeMatch((current) => ({ ...current, previewRank })),
    onApply: () => {
      if (!shapeMatchPreview) return;
      // An apply always moves the floor the source area came from, even if the
      // user is currently looking at a different level.
      if (shapeMatch.sourceFloorLabel && shapeMatch.sourceFloorLabel !== state.activeFloorLabel) {
        dispatch({ type: "setActiveFloor", label: shapeMatch.sourceFloorLabel });
      }
      dispatch({
        type: "applySimilarity",
        mode: shapeMatch.referenceFloorLabel ? "individual" : adjustmentMode,
        transform: shapeMatchPreview.transform
      });
      setShapeMatch((current) => keptMatchTarget(current));
    },
    onClear: () => setShapeMatch((current) => keptMatchTarget(current))
  };

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
    } catch (error) {
      setError(
        describeFailure(
          error,
          t(
            "Could not read that file. Re-save the .ai with 'Create PDF Compatible File' enabled.",
            "ファイルを読み込めません。「PDF互換ファイルを作成」を有効にして保存し直してください。"
          )
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
    } catch (error) {
      // Only the API knows whether the cached conversion really expired; the
      // browser still holds the file, so that case can silently re-convert.
      const expired = isApiClientError(error) && error.code === "CONVERSION_EXPIRED";
      setError(
        expired
          ? t(
              "The conversion expired. Convert the file again.",
              "変換の有効期限が切れました。もう一度変換してください。"
            )
          : describeFailure(
              error,
              t("Could not export the files.", "ファイルを書き出せませんでした。")
            )
      );
      // Retrying against a backend that is down fails again and replaces this
      // message with a complaint about the file, which is how a stopped server
      // ends up looking like a corrupt .ai.
      if (expired && lastFile) void convert(lastFile);
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
      } catch (error) {
        setError(
          describeFailure(
            error,
            t("Could not save the floor assignment.", "フロア割り当てを保存できませんでした。")
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
              alignment={preview.report.page_alignment ?? []}
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
      <PlacementSidebar
        state={state}
        dispatch={dispatch}
        mode={adjustmentMode}
        siteName={siteName}
        onLocate={setRecenterTo}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        tab={placementTab}
        onTabChange={setPlacementTab}
        pickStage={pickSession?.stage ?? null}
        onTogglePicking={() => {
          setShapeMatch((current) => keptMatchTarget(current));
          setPickSession((session) => {
            if (session) return null;
            const active = state.floors.find((floor) => floor.label === state.activeFloorLabel);
            return active
              ? {
                  stage: "artwork",
                  pendingArtwork: null,
                  floorLabel: active.label,
                  mode: adjustmentMode
                }
              : null;
          });
        }}
        shapeMatch={shapeMatchModel}
        referenceLayers={referenceLayers}
        onReferenceLayersChange={updateReferenceLayers}
        focusBounds={focusBounds}
        bounds={bounds}
        suggestedCrs={preview.suggested_crs}
        suggestedCrsLabel={preview.suggested_crs_label}
        outputCrs={outputCrs}
        onOutputCrsChange={setOutputCrs}
        formats={formats}
        onFormatsChange={setFormats}
        onExport={() => void download()}
        previewFeatures={preview.preview_features}
        totalFeatures={preview.total_features}
        error={error}
      />

      <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border">
        <PlacementMap
          floors={floorLayers}
          state={state}
          dispatch={dispatch}
          mode={adjustmentMode}
          onModeChange={(mode) => {
            setPickSession(null);
            setShapeMatch((current) => keptMatchTarget(current));
            setAdjustmentMode(mode);
          }}
          recenterTo={recenterTo}
          referenceLayers={referenceLayers}
          pickStage={pickSession?.stage ?? null}
          pendingArtwork={pickSession?.pendingArtwork ?? null}
          shapePickActive={shapeMatch.selecting}
          selectedShape={shapeMatch.selection}
          shapeMatchPreview={shapeMatchPreview}
          regionPickStage={shapeMatch.regionStage}
          regionSource={
            shapeMatch.sourceRegion && sourceFloorPlacement
              ? regionCorners(
                  resolvedTransform(state, sourceFloorPlacement),
                  shapeMatch.sourceRegion
                )
              : null
          }
          regionTarget={
            shapeMatch.targetRegion && referenceFloorPlacement
              ? regionCorners(
                  resolvedTransform(state, referenceFloorPlacement),
                  shapeMatch.targetRegion
                )
              : null
          }
          onRegionDrawn={(corners) => {
            const stage = shapeMatch.regionStage;
            if (!stage) return;
            const floor = stage === "source" ? sourceFloorPlacement : referenceFloorPlacement;
            if (!floor) return;
            const region = artworkRegion(resolvedTransform(state, floor), corners);
            setShapeMatch((current) =>
              current.regionStage !== stage
                ? current
                : stage === "source"
                  ? { ...current, sourceRegion: region, regionStage: "target" }
                  : {
                      ...current,
                      targetRegion: region,
                      regionStage: null,
                      matches: [],
                      previewRank: null,
                      searched: false,
                      error: null
                    }
            );
            // Bring the floor being boxed to the front so the next area is
            // drawn against a solid plan instead of a ghost, then hand the
            // view back once both areas are in.
            const nextLabel =
              stage === "source" ? shapeMatch.referenceFloorLabel : shapeMatch.sourceFloorLabel;
            if (nextLabel && nextLabel !== state.activeFloorLabel) {
              dispatch({ type: "setActiveFloor", label: nextLabel });
            }
          }}
          onPickShape={(selection) => {
            const active = state.floors.find((floor) => floor.label === state.activeFloorLabel);
            if (!shapeMatch.selecting || !active || selection.floorLabel !== active.label) {
              setShapeMatch((current) => ({ ...current, selecting: false }));
              return;
            }
            setShapeMatch((current) => ({
              ...current,
              selecting: false,
              selection,
              matches: [],
              previewRank: null,
              searched: false,
              error: null
            }));
          }}
          onPickArtwork={(artwork) => {
            const active = state.floors.find((floor) => floor.label === state.activeFloorLabel);
            if (
              !active ||
              !pickSession ||
              pickSession.floorLabel !== active.label ||
              pickSession.mode !== adjustmentMode
            ) {
              setPickSession(null);
              return;
            }
            setPickSession({ ...pickSession, stage: "map", pendingArtwork: artwork });
          }}
          onPickMap={(map) => {
            const active = state.floors.find((floor) => floor.label === state.activeFloorLabel);
            if (
              !active ||
              !pickSession?.pendingArtwork ||
              pickSession.floorLabel !== active.label ||
              pickSession.mode !== adjustmentMode
            ) {
              setPickSession(null);
              return;
            }
            dispatch({
              type: "addControlPoint",
              point: {
                id: `${Date.now()}`,
                artwork: pickSession.pendingArtwork,
                map
              }
            });
            const count = active.controlPoints.length + 1;
            setPickSession(
              count < MIN_CONTROL_POINTS
                ? { ...pickSession, stage: "artwork", pendingArtwork: null }
                : null
            );
          }}
        />
      </div>
    </div>
  );
}
