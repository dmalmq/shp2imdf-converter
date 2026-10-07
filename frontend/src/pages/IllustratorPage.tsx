import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";

import {
  assignFloors,
  exportIllustrator,
  matchIllustratorRegions,
  matchIllustratorShape,
  previewIllustrator,
  snapIllustratorSurvey,
  type AssignFloorsResponse,
  type ExportFormatsPayload,
  type IllustratorConversionResponse,
  type IllustratorPreviewResponse,
  type ReferenceSelection,
  type ArtworkRegion,
  type IllustratorShapeMatchSuggestion,
  type TransformPayload
} from "../api/client";
import { isApiClientError, isBackendUnreachableError, toErrorMessage } from "../api/errors";
import { ArtworkDropzone } from "../components/illustrator/ArtworkDropzone";
import type { Located } from "../components/illustrator/locateChrome";
import { AssignmentPanel } from "../components/illustrator/AssignmentPanel";
import { PageAssignmentPanel } from "../components/illustrator/PageAssignmentPanel";
import {
  ARTWORK_TINT,
  type ArtworkShapeSelection,
  type FloorLayer,
  type ReferenceLayer
} from "../components/illustrator/PlacementMap";
import { PlacementMap } from "../components/illustrator/PlacementMap";
import {
  AlignPanel,
  type PlacementTab,
  type SurveySnapModel
} from "../components/illustrator/AlignPanel";
import { ArtworkDeliver, type DeliverFloor } from "../components/illustrator/ArtworkDeliver";
import { PlacementTodo } from "../components/illustrator/PlacementTodo";
import { workingCrsLabel } from "../lib/workingCrs";
import {
  nextMatchTarget,
  surveyLayerName
} from "../components/illustrator/ReferenceLayerList";
import {
  parseMatchTarget,
  type ShapeMatchPanelModel
} from "../components/illustrator/ShapeMatchPanel";
import {
  floorsNeedingArtworkMatch,
  preferredArtworkMatchTarget
} from "../lib/artworkMatch";
import {
  placementPoseReady,
  sameSurveySnap,
  surveySnapAwaitingRetrim,
  type SurveyPose,
  type SurveySnapTarget
} from "../lib/placementPose";
import { fromDraft, NO_REFERENCES, toDraft, type DraftView } from "../lib/artworkDraft";
import { saveBlob } from "../lib/download";
import { floorStatuses, recommendedAlignment, type CurrentReferences } from "../lib/floorStatus";
import type { AlignMethod } from "../components/illustrator/ScaleAndFitPanel";
import { siteNameFromFilename, stationQueryFromFilename } from "../lib/siteName";
import { usePageShell, usePrimaryAction } from "../components/shell/ShellContext";
import { partitionByFloors, type PartitionFloor } from "../lib/svgPreview";
import { useAppStore } from "../store/useAppStore";
import {
  DEFAULT_METRES_PER_POINT,
  minControlPoints,
  initialPlacementHistory,
  pinFocusBounds,
  placementHistoryReducer,
  resolvedTransform,
  toFloorPayloads,
  type AdjustmentMode,
  type PlacementState,
  type ReferenceIdentity
} from "../hooks/useIllustratorPlacement";
import { useDraftAutosave, type DraftSaveStatus } from "../hooks/useDraftAutosave";
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

const SHAPE_MATCH_TIMEOUT_MS = 120_000;

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

function transformPayload(transform: SimilarityTransform): TransformPayload {
  return {
    artwork_anchor: transform.artworkAnchor,
    map_anchor: transform.mapAnchor,
    rotation_deg: transform.rotationDeg,
    metres_per_point: transform.metresPerPoint,
    working_crs: transform.workingCrs
  };
}

function similarityTransform(payload: TransformPayload): SimilarityTransform {
  return {
    artworkAnchor: payload.artwork_anchor,
    mapAnchor: payload.map_anchor,
    rotationDeg: payload.rotation_deg,
    metresPerPoint: payload.metres_per_point,
    workingCrs: payload.working_crs
  };
}

function previewForSuggestion(suggestion: IllustratorShapeMatchSuggestion | null) {
  if (!suggestion) return null;
  return { suggestion, transform: similarityTransform(suggestion.transform) };
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

function artworkMatchLabels(floors: PlacementState["floors"]): string[] {
  return floors.filter((floor) => floor.artworkMatch).map((floor) => floor.label);
}

function keptMatchTarget(current: Pick<ShapeMatchState, "referenceName" | "referenceFloorLabel">): ShapeMatchState {
  return {
    ...EMPTY_SHAPE_MATCH,
    referenceName: current.referenceName,
    referenceFloorLabel: current.referenceFloorLabel
  };
}

/** The draft has no tab for Shape match, so it reopens on Control points. */
function tabForMethod(method: AlignMethod): PlacementTab {
  return method === "move" ? "reference" : "fit";
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

/** Where floors start before a lookup moves them (Tokyo Station); not a guess about the drawing. */
const DEFAULT_MAP_ANCHOR: [number, number] = [139.7671, 35.6812];

function initialStateFromAssignment(
  preview: IllustratorPreviewResponse,
  assignment: AssignedRegion[],
  summary?: AssignFloorsResponse
): PlacementState {
  const regions: AssignedRegion[] = assignment.length
    ? assignment
    : [{ label: "artwork", box: preview.artwork_bounds, pages: null, layer_names: null }];
  const first = regions[0];
  const artworkMatch = new Set(
    floorsNeedingArtworkMatch(regions, preview.report.page_alignment ?? [])
  );
  return {
    frame: {
      rotationDeg: 0,
      metresPerPoint: DEFAULT_METRES_PER_POINT,
      workingCrs: preview.suggested_crs
    },
    activeFloorLabel: first.label,
    scaleLocked: true,
    floors: regions.map((region) => {
      const bounds = boundsFor(preview, region, summary);
      const needsMatch = artworkMatch.has(region.label);
      return {
        label: region.label,
        linked: !needsMatch,
        pinned: false,
        artworkMatch: needsMatch,
        artworkAnchor: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        mapAnchor: DEFAULT_MAP_ANCHOR,
        controlPoints: [],
        artworkBounds: bounds,
        ...(needsMatch
          ? { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT }
          : {})
      };
    })
  };
}

const DEFAULT_FORMATS: ExportFormatsPayload = { geopackage: false, shapefile: true, qgis: false };

const DEFAULT_STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
  activeFloorLabel: "artwork",
  scaleLocked: true,
  floors: [
    {
      label: "artwork",
      linked: true,
      pinned: false,
      artworkAnchor: [50, 50],
      mapAnchor: DEFAULT_MAP_ANCHOR,
      controlPoints: [],
      artworkBounds: [0, 0, 100, 100]
    }
  ]
};

/**
 * The saved floors that still belong to the assignment, in its order. A saved
 * floor under a label the assignment no longer has is dropped; an assigned
 * floor the draft does not hold starts from the assignment.
 */
export function reconcileFloors(saved: PlacementState, assigned: PlacementState): PlacementState {
  const floors = assigned.floors.map(
    (floor) => saved.floors.find((item) => item.label === floor.label) ?? floor
  );
  const active = floors.some((floor) => floor.label === saved.activeFloorLabel)
    ? saved.activeFloorLabel
    : assigned.activeFloorLabel;
  return { ...saved, floors, activeFloorLabel: active };
}

/**
 * A reopened project: its stored assignment, and its placement if one was
 * saved. `serverCopy` is what autosave compares against, so opening a project
 * sends nothing: the stored draft, or with none, the placement the page starts
 * from.
 */
function resume(restored: IllustratorConversionResponse | undefined) {
  if (!restored) return null;
  const assignment: AssignedRegion[] | null =
    restored.floors?.map((floor) => ({
      label: floor.label,
      box: floor.box,
      pages: floor.pages,
      layer_names: floor.layer_names
    })) ?? null;
  const assigned = initialStateFromAssignment(restored.preview, assignment ?? []);
  const saved = restored.draft && assignment ? fromDraft(restored.draft) : null;
  const state = saved ? reconcileFloors(saved.state, assigned) : assigned;
  const startingView: DraftView = {
    mode: "group",
    tab: "fit",
    outputCrs: assigned.frame.workingCrs,
    formats: DEFAULT_FORMATS,
    located: { kind: "none" },
    references: NO_REFERENCES
  };
  return {
    preview: restored.preview,
    assignment,
    state,
    view: saved?.view ?? null,
    serverCopy: restored.draft ?? (assignment ? toDraft(assigned, startingView) : null),
    startingCrs: assignment ? state.frame.workingCrs : null
  };
}


function saveProblem(status: DraftSaveStatus, t: (en: string, ja: string) => string): string | null {
  if (status === "conflict") {
    return t(
      "This project was changed in another tab. Reload the page before carrying on; changes here are no longer saved.",
      "このプロジェクトは別のタブで変更されました。続ける前にページを再読み込みしてください。ここでの変更は保存されません。"
    );
  }
  if (status === "gone") {
    return t(
      "This project is no longer on this PC, so changes here are not saved.",
      "このプロジェクトはこの PC に残っていないため、ここでの変更は保存されません。"
    );
  }
  if (status === "failed") {
    return t("Could not save the placement. Retrying…", "配置を保存できませんでした。再試行しています…");
  }
  return null;
}

/**
 * Why the drawing is still at the default spot, when nothing located it: the
 * lookup found nothing, could not be asked, or never ran (a file name with no
 * station in it, or a project saved before lookups were recorded).
 */
export function defaultSpotNotice(located: Located, t: (en: string, ja: string) => string): string | null {
  if (located.kind === "not-found") {
    return t(
      `No place called “${located.query}” was found, so the drawing sits at a default spot in central Tokyo. Search for the building, or drag the drawing onto it.`,
      `「${located.query}」に当たる場所が見つからないため、図面は東京都心の仮の位置にあります。建物を検索するか、図面を建物までドラッグしてください。`
    );
  }
  if (located.kind === "unavailable") {
    return t(
      `Could not look up “${located.query}”, so the drawing sits at a default spot in central Tokyo. Search for the building, or drag the drawing onto it.`,
      `「${located.query}」を検索できなかったため、図面は東京都心の仮の位置にあります。建物を検索するか、図面を建物までドラッグしてください。`
    );
  }
  if (located.kind === "none") {
    return t(
      "No location was found for this drawing, so it sits at a default spot in central Tokyo. Search for the building, or drag the drawing onto it.",
      "この図面の位置が見つからないため、図面は東京都心の仮の位置にあります。建物を検索するか、図面を建物までドラッグしてください。"
    );
  }
  return null;
}

type Props = {
  /** Converted on arrival: the file dropped on the hub. */
  initialFile?: File;
  /** A stored conversion to reopen where it was left. */
  restored?: IllustratorConversionResponse;
  /** Called with each conversion this page creates, so the URL can name it. */
  onConversion?: (conversionId: string) => void;
};

export function IllustratorPage({ initialFile, restored, onConversion }: Props = {}) {
  const { t } = useUiLanguage();
  const [resumed] = useState(() => resume(restored));
  const [preview, setPreview] = useState<IllustratorPreviewResponse | null>(resumed?.preview ?? null);
  const [assignment, setAssignment] = useState<AssignedRegion[] | null>(
    resumed?.assignment ?? null
  );
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickSession, setPickSession] = useState<PickSession | null>(null);
  const [shapeMatch, setShapeMatch] = useState<ShapeMatchState>(EMPTY_SHAPE_MATCH);
  const [inspectedMatch, setInspectedMatch] =
    useState<IllustratorShapeMatchSuggestion | null>(null);
  const [outputCrs, setOutputCrs] = useState(
    resumed?.view?.outputCrs ?? resumed?.startingCrs ?? "EPSG:4326"
  );
  // Shapefile only by default. This route's job is Illustrator -> shapefiles;
  // defaulting all three handed the user two artifacts they never asked for.
  const [formats, setFormats] = useState<ExportFormatsPayload>(
    resumed?.view?.formats ?? DEFAULT_FORMATS
  );
  const [history, dispatch] = useReducer(
    placementHistoryReducer,
    resumed?.state ?? DEFAULT_STATE,
    initialPlacementHistory
  );
  const state = history.present;
  const [recenterTo, setRecenterTo] = useState<[number, number] | null>(null);
  const [referenceLayers, setReferenceLayers] = useState<ReferenceLayer[]>([]);
  const [placementTab, setPlacementTab] = useState<PlacementTab>(resumed?.view?.tab ?? "fit");
  const [alignMethod, setAlignMethod] = useState<AlignMethod>(
    resumed?.view?.tab === "reference" ? "move" : "points"
  );
  const [located, setLocated] = useState<Located>(resumed?.view?.located ?? { kind: "none" });
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection>(
    resumed?.view?.references ?? NO_REFERENCES
  );
  const [surveyNotice, setSurveyNotice] = useState<string | null>(null);
  const [surveyPose, setSurveyPose] = useState<SurveyPose>("idle");
  // A restored placement never looks the file name up again, so it is settled already.
  const [locateSettled, setLocateSettled] = useState(Boolean(resumed?.view));

  // A shape match against a station-sized reference layer is a long request, and
  // an unbounded one is indistinguishable from a hang. Bound it, let the user
  // stop it, and make a superseded request abandon quietly.
  const matchAbortRef = useRef<AbortController | null>(null);
  const matchTimedOutRef = useRef(false);

  const beginMatch = () => {
    matchAbortRef.current?.abort();
    matchTimedOutRef.current = false;
    const controller = new AbortController();
    matchAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      matchTimedOutRef.current = true;
      controller.abort();
    }, SHAPE_MATCH_TIMEOUT_MS);
    return { controller, timer };
  };

  const endMatch = (handle: { controller: AbortController; timer: number }) => {
    window.clearTimeout(handle.timer);
    if (matchAbortRef.current === handle.controller) matchAbortRef.current = null;
  };

  /** True when the throw was an abort we caused, so the state is someone else's. */
  const handledAbort = (error: unknown) => {
    if (!(error instanceof DOMException) || error.name !== "AbortError") return false;
    if (matchTimedOutRef.current) {
      matchTimedOutRef.current = false;
      setShapeMatch((current) => ({
        ...current,
        loading: false,
        searched: true,
        error: t(
          "The comparison ran too long and was stopped. Try a more distinctive outline, or trim the reference layer.",
          "比較に時間がかかりすぎたため中止しました。より特徴的な外周を選ぶか、参照レイヤーを絞り込んでください。"
        )
      }));
    }
    return true;
  };

  const cancelShapeMatch = () => {
    matchAbortRef.current?.abort();
    matchAbortRef.current = null;
    matchTimedOutRef.current = false;
    setShapeMatch((current) => ({ ...current, loading: false, searched: false, error: null }));
  };

  // The Station_pg collection last sent for a snap, keyed with the pin it used.
  // A re-trimmed layer is a new object and snaps again; a frame nudge or a lock
  // toggle leaves it alone. The counter drops a response that lands after a
  // newer snap or a new conversion.
  const snappedRef = useRef<SurveySnapTarget | null>(null);
  const surveySnapGen = useRef(0);
  // A resumed placement was already snapped (or deliberately moved after); the
  // survey layer re-queried for its pin must not snap it again.
  const resumedPin = useRef(resumed?.view ? (resumed.state.stationPin ?? null) : null);
  // Floors start grouped: the whole building is aligned first, then the user
  // switches to individual mode for final per-floor nudges. UI-level only —
  // never an undo step.
  const [adjustmentMode, setAdjustmentMode] = useState<AdjustmentMode>(
    resumed?.view?.mode ?? "group"
  );

  const draft = useMemo(() => {
    if (!preview || assignment === null) return null;
    const view: DraftView = {
      mode: adjustmentMode,
      tab: placementTab,
      outputCrs,
      formats,
      located,
      references: referenceSelection
    };
    return toDraft(state, view);
  }, [preview, assignment, state, adjustmentMode, placementTab, outputCrs, formats, located, referenceSelection]);
  const autosave = useDraftAutosave(
    draft,
    restored
      ? {
          conversionId: restored.conversion_id,
          revision: restored.draft_revision,
          saved: resumed?.serverCopy ?? null,
          savedAt: restored.project.updated_at ? Date.parse(restored.project.updated_at) : null
        }
      : null,
    // Nothing undoable has happened: this is where the page started (the
    // assignment, then the filename lookup), not an edit anyone made.
    history.past.length === 0
  );

  // Publish the stage so the header rail can show THIS route's progress. Derived
  // rather than stored so it can never disagree with what is on screen.
  const setIllustratorStage = useAppStore((s) => s.setIllustratorStage);
  useEffect(() => {
    setIllustratorStage(!preview ? 1 : assignment === null ? 2 : 3);
  }, [preview, assignment, setIllustratorStage]);

  // Only on the placement view: the upload and assignment screens have their own
  // keyboard behaviour and no floor to nudge.
  usePlacementShortcuts({
    state,
    dispatch,
    mode: adjustmentMode,
    enabled: Boolean(preview) && assignment !== null && placementTab !== "export",
    onEscape: () => {
      setPickSession(null);
      setInspectedMatch(null);
      setShapeMatch((current) => ({ ...current, selecting: false, previewRank: null }));
    }
  });

  useEffect(() => {
    setInspectedMatch(null);
    setPickSession(null);
    setShapeMatch((current) => {
      // Switching levels is how the user gets a clear look at the floor being
      // boxed, so an area pick has to survive it. Only the outline selection,
      // which belongs to one floor, is discarded. Mode changes go through the
      // map toggle (which already drops the outline) or Match-to-floor, which
      // starts a pick and must not wipe it.
      if (current.regionStage || current.sourceRegion || current.targetRegion) {
        return { ...current, selecting: false, selection: null };
      }
      return {
        ...EMPTY_SHAPE_MATCH,
        ...nextMatchTarget(
          referenceLayers,
          state.floors.map((floor) => floor.label),
          state.activeFloorLabel,
          current,
          artworkMatchLabels(state.floors)
        )
      };
    });
  }, [state.activeFloorLabel]);

  // Computed unconditionally so the hook order is stable across the early
  // returns below (a conditional hook here crashes the placement view).
  const bounds: [number, number, number, number] =
    preview?.artwork_bounds ?? ([0, 0, 100, 100] as [number, number, number, number]);

  const siteName = stationQueryFromFilename(preview?.report?.source_name ?? "");

  const sourceName = preview?.report?.source_name ?? "";
  const placing = Boolean(preview) && assignment !== null;
  const currentReferences: CurrentReferences = useMemo(
    () => ({
      preloaded: referenceSelection.preloaded,
      uploads: referenceSelection.uploads,
      removed: referenceSelection.removed,
      pin: state.stationPin ?? null
    }),
    [referenceSelection, state.stationPin]
  );
  const referenceIdentity = (layer: string): ReferenceIdentity => ({
    layer,
    preloaded: referenceSelection.preloaded,
    uploads: [...referenceSelection.uploads],
    pin: state.stationPin ?? null
  });
  const statuses = useMemo(() => floorStatuses(state, currentReferences), [state, currentReferences]);
  const alignedFloors = [...statuses.values()].filter((status) => status.kind === "aligned").length;
  const shellStation = siteNameFromFilename(sourceName) || sourceName.replace(/\.[^.]+$/, "") || null;
  usePageShell({
    station: shellStation,
    current: placing && placementTab === "export" ? "deliver" : null,
    targets: placing ? [placementTab === "export" ? "place" : "deliver"] : [],
    go: { place: () => setPlacementTab(tabForMethod(alignMethod)), deliver: () => setPlacementTab("export") },
    floorsAligned: placing ? { aligned: alignedFloors, total: state.floors.length } : null,
    artworkRead: preview
      ? { pages: preview.pages.length, floors: placing ? state.floors.length : null }
      : null,
    save: placing
      ? {
          state:
            autosave.status === "conflict" || autosave.status === "gone"
              ? "stopped"
              : autosave.status,
          savedAt: autosave.savedAt
        }
      : null
  });

  usePrimaryAction(
    placing && placementTab !== "export"
      ? { label: t("Deliver →", "書き出しへ →"), run: () => setPlacementTab("export") }
      : null
  );

  // The draft's tab follows the method so a reload reopens it. The recommendation made as
  // the page opens is left out: opening a project must not save anything.
  const showMethod = (method: AlignMethod, remember = true) => {
    setAlignMethod(method);
    if (remember) setPlacementTab((tab) => (tab === "export" ? tab : tabForMethod(method)));
  };
  // A floor that did not stack opens on its recommended method; the other stays one click away.
  const recommendFor = (label: string | null, remember = true): AlignMethod => {
    const floor = state.floors.find((item) => item.label === label);
    if (!floor || statuses.get(floor.label)?.kind === "aligned") return alignMethod;
    // With no station pin the building has not been found yet, so that comes first.
    const method =
      recommendedAlignment(state, floor).kind === "match-floor" ? "shape" : state.stationPin ? "points" : "move";
    showMethod(method, remember);
    return method;
  };
  const opened = useRef(false);
  useEffect(() => {
    recommendFor(state.activeFloorLabel, opened.current);
    opened.current = true;
  }, [state.activeFloorLabel, placing]);

  const reviewFloor = (label: string) => {
    if (label !== state.activeFloorLabel) dispatch({ type: "setActiveFloor", label });
    setPlacementTab(tabForMethod(recommendFor(label)));
  };

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
    return regions.map((region) => ({
      label: region.label,
      features: perFloor.get(region.label) ?? [],
      bounds: boundsFor(preview, region),
      color: ARTWORK_TINT
    }));
  }, [preview, assignment]);

  const deliverFloors: DeliverFloor[] = (assignment ?? []).map((region) => ({
    label: region.label,
    pages: region.pages,
    box: region.box !== null && region.label !== "artwork",
    shapes: floorLayers.find((floor) => floor.label === region.label)?.features.length ?? 0
  }));

  const pageSizes = new Set(
    (preview?.pages ?? []).map((page) => `${Math.round(page.width_pt)}x${Math.round(page.height_pt)}`)
  );
  const placementNotes =
    pageSizes.size > 1
      ? [
          t(
            "The pages are not all the same size, so their plans may land offset. Align the building as a group first, then adjust any floor that needs its own position.",
            "ページのサイズが揃っていないため、各階の位置がずれる場合があります。まずグループで建物全体を合わせてから、位置が合わないフロアを個別に調整してください。"
          )
        ]
      : [];

  const focusBounds = useMemo(
    () => (state.stationPin ? pinFocusBounds(state.stationPin) : null),
    [state.stationPin]
  );

  // A resumed output CRS is the user's choice; only a later zone change replaces it.
  const syncedCrs = useRef(resumed?.startingCrs ?? null);
  useEffect(() => {
    if (syncedCrs.current === state.frame.workingCrs) return;
    syncedCrs.current = state.frame.workingCrs;
    setOutputCrs(state.frame.workingCrs);
  }, [state.frame.workingCrs]);

  const referenceFloorPlacement =
    state.floors.find((floor) => floor.label === shapeMatch.referenceFloorLabel) ?? null;
  const sourceFloorPlacement =
    state.floors.find((floor) => floor.label === shapeMatch.sourceFloorLabel) ?? null;

  const selectedSuggestion =
    shapeMatch.matches.find((match) => match.rank === shapeMatch.previewRank) ?? null;
  const inspectedSuggestion =
    inspectedMatch && shapeMatch.matches.includes(inspectedMatch) ? inspectedMatch : null;
  const selectedShapeMatchPreview = useMemo(
    () => previewForSuggestion(selectedSuggestion),
    [selectedSuggestion]
  );
  const shapeMatchPreview = useMemo(
    () => previewForSuggestion(inspectedSuggestion ?? selectedSuggestion),
    [inspectedSuggestion, selectedSuggestion]
  );

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

  const surveyName = surveyLayerName(referenceLayers);
  const surveyCollection =
    referenceLayers.find((layer) => layer.name === surveyName)?.data ?? null;
  const surveyHasFeatures = Boolean(surveyCollection && surveyCollection.features.length > 0);
  const snapMatchesCurrent = sameSurveySnap(
    snappedRef.current,
    surveyCollection,
    state.stationPin
  );
  const poseReady = placementPoseReady(Boolean(state.stationPin), surveyHasFeatures, surveyPose, {
    locateSettled,
    snapMatchesCurrent
  });
  const snapToSurvey = async (reference: FeatureCollection, chosen = false) => {
    // A group apply moves the linked floors through the active floor, so an
    // unlinked active floor hands the anchor to the first floor still linked.
    const active = state.floors.find((floor) => floor.label === state.activeFloorLabel);
    const anchor = active?.linked ? active : state.floors.find((floor) => floor.linked);
    const pin = state.stationPin;
    setSurveyPose("pending");
    if (!preview || !anchor || !pin) {
      if (pin) snappedRef.current = { collection: reference, pin };
      setSurveyPose("ready");
      return;
    }
    snappedRef.current = { collection: reference, pin };
    const gen = ++surveySnapGen.current;
    try {
      const { match } = await snapIllustratorSurvey(preview.conversion_id, {
        current_transform: transformPayload(resolvedTransform(state, anchor)),
        scale_locked: state.scaleLocked,
        reference
      });
      if (gen !== surveySnapGen.current) return;
      if (!match) {
        setSurveyNotice(
          t(
            "No consensus among the Station_pg outlines, so the drawing stayed put.",
            "Station_pg の外周で合意が取れなかったため、図面はそのままです。"
          )
        );
        return;
      }
      if (anchor.label !== state.activeFloorLabel) {
        dispatch({ type: "setActiveFloor", label: anchor.label });
      }
      dispatch({
        type: "applySimilarity",
        mode: "group",
        transform: similarityTransform(match.transform),
        ...(chosen
          ? { alignedTo: { kind: "reference" as const, reference: referenceIdentity(surveyLayerName(referenceLayers)) } }
          : {})
      });
      const percent = Math.round(match.overlap_iou * 100);
      setSurveyNotice(
        t(`Snapped at ${percent}% overlap.`, `重なり ${percent}% でスナップしました。`)
      );
    } catch (error) {
      if (gen !== surveySnapGen.current) return;
      setSurveyNotice(
        describeFailure(
          error,
          t("Could not snap to Station_pg.", "Station_pg にスナップできませんでした。")
        )
      );
    } finally {
      if (gen === surveySnapGen.current) setSurveyPose("ready");
    }
  };

  useEffect(() => {
    if (!preview || assignment === null || !state.stationPin || !state.scaleLocked) return;
    if (!surveyCollection || surveyCollection.features.length === 0) return;
    const pin = resumedPin.current;
    if (!snappedRef.current && pin && pin[0] === state.stationPin[0] && pin[1] === state.stationPin[1]) {
      snappedRef.current = { collection: surveyCollection, pin: state.stationPin };
      setSurveyPose("ready");
      return;
    }
    if (sameSurveySnap(snappedRef.current, surveyCollection, state.stationPin)) return;
    if (surveySnapAwaitingRetrim(snappedRef.current, surveyCollection, state.stationPin)) return;
    void snapToSurvey(surveyCollection);
  }, [preview, assignment, state.stationPin, state.scaleLocked, surveyCollection]);

  const surveySnapModel: SurveySnapModel = {
    layerName: surveyName,
    notice: surveyNotice,
    onSnap: () => {
      if (surveyCollection) void snapToSurvey(surveyCollection, true);
    }
  };

  const updateReferenceLayers = (layers: ReferenceLayer[]) => {
    const geometryReplaced = referenceLayers.some((old) => {
      const next = layers.find((layer) => layer.name === old.name);
      return next !== undefined && next.data !== old.data;
    });
    setReferenceLayers(layers);
    setShapeMatch((current) => {
      const next = nextMatchTarget(
        layers,
        state.floors.map((floor) => floor.label),
        state.activeFloorLabel,
        current,
        artworkMatchLabels(state.floors)
      );
      if (
        !geometryReplaced &&
        next.referenceName === current.referenceName &&
        next.referenceFloorLabel === current.referenceFloorLabel
      ) {
        return current;
      }
      return {
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

    setInspectedMatch(null);
    setShapeMatch((current) => ({ ...current, loading: true, searched: false, error: null }));
    const currentTransform = resolvedTransform(state, active);
    const handle = beginMatch();
    try {
      const response = await matchIllustratorShape(preview.conversion_id, {
        floor_label: active.label,
        artwork: {
          source_table: selection.sourceTable,
          source_row: selection.sourceRow
        },
        current_transform: transformPayload(currentTransform),
        scale_locked: state.scaleLocked,
        ...(referenceFloor
          ? {
              reference_floor: {
                label: referenceFloor.label,
                transform: transformPayload(resolvedTransform(state, referenceFloor))
              }
            }
          : { reference: reference!.data })
      }, handle.controller.signal);
      endMatch(handle);
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
          : { ...current, loading: false }
      );
    } catch (error) {
      endMatch(handle);
      if (handledAbort(error)) return;
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
          : { ...current, loading: false }
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

    setInspectedMatch(null);
    setShapeMatch((current) => ({ ...current, loading: true, searched: false, error: null }));
    const handle = beginMatch();
    try {
      const response = await matchIllustratorRegions(preview.conversion_id, {
        floor_label: sourceFloor.label,
        region: sourceRegion,
        current_transform: transformPayload(resolvedTransform(state, sourceFloor)),
        scale_locked: state.scaleLocked,
        reference_floor: {
          label: referenceFloor.label,
          transform: transformPayload(resolvedTransform(state, referenceFloor)),
          region: targetRegion
        }
      }, handle.controller.signal);
      endMatch(handle);
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
          : { ...current, loading: false }
      );
    } catch (error) {
      endMatch(handle);
      if (handledAbort(error)) return;
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
          : { ...current, loading: false }
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
    onCancel: cancelShapeMatch,
    onPreview: (previewRank) => setShapeMatch((current) => ({ ...current, previewRank })),
    onInspect: (rank) =>
      setInspectedMatch(
        rank === null ? null : (shapeMatch.matches.find((match) => match.rank === rank) ?? null)
      ),
    artworkMatchTarget:
      state.floors.find((floor) => floor.label === state.activeFloorLabel)?.artworkMatch
        ? preferredArtworkMatchTarget(state.activeFloorLabel ?? "", state.floors)
        : "",
    onStartArtworkMatch: () => {
      const active = state.activeFloorLabel;
      if (!active) return;
      const target = preferredArtworkMatchTarget(active, state.floors);
      if (!target) return;
      setAdjustmentMode("individual");
      setPlacementTab("fit");
      setPickSession(null);
      setShapeMatch({
        ...EMPTY_SHAPE_MATCH,
        sourceFloorLabel: active,
        referenceFloorLabel: target,
        selecting: true
      });
    },
    onApply: () => {
      if (!selectedShapeMatchPreview) return;
      const sourceLabel =
        shapeMatch.sourceFloorLabel ||
        shapeMatch.selection?.floorLabel ||
        state.activeFloorLabel;
      const sourceFloor = state.floors.find((floor) => floor.label === sourceLabel);
      if (sourceFloor?.pinned) return;
      // An apply always moves the floor the source area came from, even if the
      // user is currently looking at a different level.
      if (shapeMatch.sourceFloorLabel && shapeMatch.sourceFloorLabel !== state.activeFloorLabel) {
        dispatch({ type: "setActiveFloor", label: shapeMatch.sourceFloorLabel });
      }
      dispatch({
        type: "applySimilarity",
        mode: shapeMatch.referenceFloorLabel ? "individual" : adjustmentMode,
        transform: selectedShapeMatchPreview.transform,
        alignedTo: shapeMatch.referenceFloorLabel
          ? { kind: "floor", floor: shapeMatch.referenceFloorLabel }
          : { kind: "reference", reference: referenceIdentity(shapeMatch.referenceName) }
      });
      setInspectedMatch(null);
      setShapeMatch((current) => keptMatchTarget(current));
    },
    onClear: () => {
      setInspectedMatch(null);
      setShapeMatch((current) => keptMatchTarget(current));
    }
  };

  const install = (response: IllustratorPreviewResponse, file: File) => {
    setPreview(response);
    setAssignment(null);
    setRecenterTo(null);
    setReferenceLayers([]);
    setSurveyNotice(null);
    setSurveyPose("idle");
    setLocateSettled(false);
    setLocated({ kind: "none" });
    setReferenceSelection(NO_REFERENCES);
    snappedRef.current = null;
    resumedPin.current = null;
    surveySnapGen.current += 1;
    setLastFile(file);
    setOutputCrs(response.suggested_crs);
    // New conversions start locked at 1:1000; assignment reset does the same.
    dispatch({ type: "resetPlacement", state: initialStateFromAssignment(response, []) });
    onConversion?.(response.conversion_id);
  };

  const convert = async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      install(await previewIllustrator(file), file);
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

  const handedOver = useRef(false);
  useEffect(() => {
    if (!initialFile || handedOver.current) return;
    handedOver.current = true;
    void convert(initialFile);
  }, []);

  /**
   * Re-cache an expired conversion from the file the browser still holds and
   * re-apply the floor assignment, so placement state and undo history survive.
   * Null when the file no longer fits that assignment; the page is then reset
   * to the assignment step for the fresh conversion.
   */
  const renewConversion = async (
    current: IllustratorPreviewResponse,
    file: File,
    regions: AssignedRegion[]
  ): Promise<IllustratorPreviewResponse | null> => {
    const fresh = await previewIllustrator(file);
    if (fresh.artwork_bounds.some((value, index) => value !== current.artwork_bounds[index])) {
      install(fresh, file);
      return null;
    }
    let summary: AssignFloorsResponse;
    try {
      summary = await assignFloors(fresh.conversion_id, regions);
    } catch (error) {
      if (isBackendUnreachableError(error)) throw error;
      install(fresh, file);
      return null;
    }
    setPreview(fresh);
    autosave.track(fresh.conversion_id, summary.draft_revision, null);
    onConversion?.(fresh.conversion_id);
    return fresh;
  };

  const download = async () => {
    if (!preview) return;
    setError(null);
    const body = { floors: toFloorPayloads(state), output_crs: outputCrs, formats };
    try {
      let result: Awaited<ReturnType<typeof exportIllustrator>>;
      try {
        result = await exportIllustrator(preview.conversion_id, body);
      } catch (error) {
        const expired = isApiClientError(error) && error.code === "CONVERSION_EXPIRED";
        if (!expired || !lastFile || !assignment) throw error;
        const renewed = await renewConversion(preview, lastFile, assignment);
        if (!renewed) {
          setError(
            t(
              "The conversion expired and the file no longer matches its floor assignment. Assign the floors again.",
              "変換の有効期限が切れ、ファイルがフロア割り当てと一致しなくなりました。フロアをもう一度割り当ててください。"
            )
          );
          return;
        }
        result = await exportIllustrator(renewed.conversion_id, body);
      }
      saveBlob(result.blob, result.filename);
    } catch (error) {
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
    }
  };

  if (!preview) {
    return <ArtworkDropzone loading={loading} error={error} onFile={(file) => void convert(file)} />;
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
        autosave.track(preview.conversion_id, summary.draft_revision, null);
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
    // Skip is an assignment too, so the server can find the outlines to snap.
    const wholeArtwork: PartitionFloor = {
      label: "artwork",
      box: preview.artwork_bounds,
      pages: null,
      layerNames: null
    };

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <p role="alert" className="border-b border-border bg-destructive-muted px-14 py-2 text-[13px] leading-[18px] text-destructive">
            {error}
          </p>
        ) : null}
        {preview.pages.length > 1 ? (
          <PageAssignmentPanel
            preview={preview.preview}
            pages={preview.pages}
            layerSummaries={preview.layers}
            alignment={preview.report.page_alignment ?? []}
            onSkip={() => void commitAssignment([wholeArtwork])}
            onAssigned={commitAssignment}
          />
        ) : (
          <AssignmentPanel
            preview={preview.preview}
            artworkBounds={preview.artwork_bounds}
            layerSummaries={preview.layers}
            onSkip={() => void commitAssignment([wholeArtwork])}
            onAssigned={commitAssignment}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* Covered by Deliver but still mounted, so it has to leave the tab order and the
          accessibility tree. React 18 only passes `inert` through as a string. */}
      <div className="contents" {...(placementTab === "export" ? { inert: "" } : null)}>
      <PlacementTodo
        state={state}
        dispatch={dispatch}
        statuses={statuses}
        onAlign={reviewFloor}
        artworkBounds={bounds}
        notes={placementNotes}
        references={currentReferences}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AlignPanel
          state={state}
          dispatch={dispatch}
          mode={adjustmentMode}
          siteName={siteName}
          conversionId={preview.conversion_id}
          onLocate={setRecenterTo}
          onLookupSettled={() => setLocateSettled(true)}
          restoredLocation={resumed?.view ? resumed.view.located : undefined}
          onLocatedChange={setLocated}
          referenceSelection={resumed?.view?.references}
          onReferenceSelectionChange={setReferenceSelection}
          canUndo={history.past.length > 0}
          canRedo={history.future.length > 0}
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
          alignMethod={alignMethod}
          onAlignMethodChange={showMethod}
          statuses={statuses}
          references={currentReferences}
          surveySnap={surveySnapModel}
          referenceLayers={referenceLayers}
          onReferenceLayersChange={updateReferenceLayers}
          focusBounds={focusBounds}
        />
        {/* `bg-popover` rather than a literal white: this sits over the map and
            has to stay readable when the page is dark. */}
        {!poseReady ? (
          <p
            data-testid="placement-hold"
            className="pointer-events-none absolute left-0 right-[356px] top-3 z-30 mx-auto w-fit rounded-md border border-border bg-popover/95 px-3 py-1 text-xs leading-4 text-muted-foreground shadow-sm"
          >
            {state.stationPin
              ? t("Snapping to Station_pg…", "Station_pg に合わせています…")
              : t("Locating the station…", "駅を検索しています…")}
          </p>
        ) : null}
        {locateSettled &&
        state.floors.some(
          (floor) =>
            floor.mapAnchor[0] === DEFAULT_MAP_ANCHOR[0] && floor.mapAnchor[1] === DEFAULT_MAP_ANCHOR[1]
        ) &&
        defaultSpotNotice(located, t) ? (
          <p
            role="status"
            data-testid="lookup-failed"
            className="absolute left-0 right-[356px] top-16 z-30 mx-auto w-fit max-w-[70%] rounded-md border border-warning bg-warning-surface px-3 py-1.5 text-xs leading-4 text-warning-foreground shadow-sm"
          >
            {defaultSpotNotice(located, t)}
          </p>
        ) : null}
        {saveProblem(autosave.status, t) ? (
          <p
            role="status"
            data-testid="draft-save-problem"
            className="absolute left-0 right-[356px] bottom-3 z-30 mx-auto w-fit max-w-[80%] rounded-md border border-border bg-popover/95 px-3 py-1 text-xs leading-4 text-destructive shadow-sm"
          >
            {saveProblem(autosave.status, t)}
          </p>
        ) : null}
        <PlacementMap
          floors={floorLayers}
          state={state}
          dispatch={dispatch}
          mode={adjustmentMode}
          artworkVisible={poseReady}
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
              count < minControlPoints(state)
                ? { ...pickSession, stage: "artwork", pendingArtwork: null }
                : null
            );
          }}
          statuses={statuses}
          toolsInset={372}
        />
      </div>
      </div>

      {/* Over the placement rather than instead of it: the map, the locate
          lookup and the reference layers keep their state while Deliver is open. */}
      <div
        hidden={placementTab !== "export"}
        className={placementTab === "export" ? "absolute inset-0 z-40 flex flex-col bg-background" : undefined}
      >
          <ArtworkDeliver
            state={state}
            statuses={statuses}
            references={currentReferences}
            station={shellStation ?? ""}
            stem={sourceName.replace(/\.[^.]+$/, "") || "artwork"}
            floors={deliverFloors}
            shapesFromPreview={preview.preview_features !== preview.total_features}
            crsChoices={[
              { value: state.frame.workingCrs, label: workingCrsLabel(state.frame.workingCrs) },
              { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
            ]}
            outputCrs={outputCrs}
            onOutputCrsChange={setOutputCrs}
            formats={formats}
            onFormatsChange={setFormats}
            onExport={() => void download()}
            error={error}
            onReview={reviewFloor}
            onBackToMap={() => setPlacementTab(tabForMethod(alignMethod))}
          />
      </div>
    </div>
  );
}
