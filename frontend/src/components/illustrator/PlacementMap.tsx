import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon
} from "geojson";
import { Pin } from "lucide-react";
import {
  Layer,
  Marker,
  type MapLayerMouseEvent,
  type MapRef,
  Source
} from "react-map-gl/maplibre";
import type { Map as MaplibreMap } from "maplibre-gl";

import { MapView } from "../shared/MapView";

import type { IllustratorShapeMatchSuggestion } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  resolvedTransform,
  type ControlPoint,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import {
  artworkFromLngLat,
  artworkToLngLat,
  geometryPositions,
  gizmoFrame,
  nearestVertex,
  transformGeoJson,
  type SimilarityTransform
} from "../../lib/similarity";
import {
  BASEMAP_ORDER,
  BASEMAP_STYLES,
  basemapLabel,
  isImageryBasemap,
  type BasemapId
} from "../shared/basemapStyles";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ARTWORK_VIEW,
  floorPaint,
  toggleOthersHidden,
  toggleTransparent,
  type ArtworkView
} from "./artworkView";
import { TransformHandles } from "./TransformHandles";
import { Contrast, Layers, Maximize2 } from "lucide-react";
import { OVERLAY_COLORS } from "./overlayColors";
import { WARNING_MAP_COLORS } from "../shared/warningColors";
import {
  ARTWORK_SLOT_LAYER_ID,
  ARTWORK_SLOT_SOURCE_ID,
  EMPTY_FEATURE_COLLECTION,
  OVERLAY_SLOT_LAYER_ID,
  OVERLAY_SLOT_SOURCE_ID,
  artworkLayerFilter,
  floorFillLayerId,
  floorLineLayerId,
  floorSourceId,
  layerVisibility,
  referenceFillLayerId,
  referenceLineLayerId,
  referencePointLayerId,
  referenceSourceId
} from "./placementMapLayers";

/**
 * Fallback colour for the active floor, used when the artwork carries no colour
 * of its own. `signal` — reserved for the placed artwork and nothing else.
 *
 * Replaces a six-entry `FLOOR_TINTS` list: floors no longer each own a hue, so
 * there is one tint rather than one per floor.
 */
export const ARTWORK_TINT = "#ea580c";
const PLACEMENT_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

/** Snap radius for control-point picking, in screen pixels. */
const SNAP_PX = 12;

const OUTLINE_GEOMETRY_TYPES = new Set([
  "Polygon",
  "MultiPolygon",
  "LineString",
  "MultiLineString"
]);
const LINE_GEOMETRY_TYPES = new Set(["LineString", "MultiLineString"]);

type OutlineGeometry = Polygon | MultiPolygon | LineString | MultiLineString;

type OutlineHit = {
  geometry?: { type: string } | null;
  properties?: Feature["properties"];
};

function lookupOutlineFeature(
  hit: OutlineHit,
  layerFeatures: Feature[]
): Feature<OutlineGeometry> | null {
  if (!hit.geometry || !OUTLINE_GEOMETRY_TYPES.has(hit.geometry.type)) return null;
  const sourceTable = hit.properties?.source_table;
  const sourceRow = Number(hit.properties?.source_row);
  if (typeof sourceTable !== "string" || !Number.isInteger(sourceRow)) return null;
  const feature = layerFeatures.find(
    (candidate) =>
      candidate.properties?.source_table === sourceTable &&
      Number(candidate.properties?.source_row) === sourceRow &&
      candidate.geometry &&
      OUTLINE_GEOMETRY_TYPES.has(candidate.geometry.type)
  );
  return (feature as Feature<OutlineGeometry> | undefined) ?? null;
}

/**
 * A click on a filled room takes that polygon; otherwise a nearby stroked
 * path can be the outline. Neighbouring fills in the snap box lose to lines.
 */
export function resolvePickedOutline(
  exactFillHits: OutlineHit[],
  nearbyHits: OutlineHit[],
  layerFeatures: Feature[]
): Feature<OutlineGeometry> | null {
  for (const hit of exactFillHits) {
    const feature = lookupOutlineFeature(hit, layerFeatures);
    if (feature) return feature;
  }
  for (const hit of nearbyHits) {
    if (!hit.geometry || !LINE_GEOMETRY_TYPES.has(hit.geometry.type)) continue;
    const feature = lookupOutlineFeature(hit, layerFeatures);
    if (feature) return feature;
  }
  for (const hit of nearbyHits) {
    const feature = lookupOutlineFeature(hit, layerFeatures);
    if (feature) return feature;
  }
  return null;
}

export function buildControlPointOverlay(
  controlPoints: ControlPoint[],
  transform: SimilarityTransform
): FeatureCollection {
  const features: Feature[] = [];
  controlPoints.forEach((point, index) => {
    const artwork = artworkToLngLat(transform, point.artwork[0], point.artwork[1]);
    const label = String(index + 1);
    features.push(
      {
        type: "Feature",
        properties: { kind: "residual", label },
        geometry: { type: "LineString", coordinates: [artwork, point.map] }
      },
      {
        type: "Feature",
        properties: { kind: "artwork", label },
        geometry: { type: "Point", coordinates: artwork }
      },
      {
        type: "Feature",
        properties: { kind: "reference", label },
        geometry: { type: "Point", coordinates: point.map }
      }
    );
  });
  return { type: "FeatureCollection", features };
}

export type FloorLayer = {
  label: string;
  features: Feature[];
  bounds: [number, number, number, number];
  color: string;
};

type ArtworkLayerSummary = {
  name: string;
  featureCount: number;
};

type FloorArtworkLayers = {
  floorLabel: string;
  color: string;
  layers: ArtworkLayerSummary[];
};

function artworkLayerName(feature: Feature): string {
  const aiLayer = feature.properties?.ai_layer;
  if (typeof aiLayer === "string") return aiLayer;
  const sourceTable = feature.properties?.source_table;
  return typeof sourceTable === "string" ? sourceTable : "";
}

function summarizeArtworkLayers(floors: FloorLayer[]): FloorArtworkLayers[] {
  return floors.map((floor) => {
    const counts = new Map<string, number>();
    for (const feature of floor.features) {
      const name = artworkLayerName(feature);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return {
      floorLabel: floor.label,
      color: floor.color,
      layers: [...counts].map(([name, featureCount]) => ({ name, featureCount }))
    };
  });
}

/** Existing GIS data drawn under the artwork purely to align against. */
export type ReferenceLayer = {
  name: string;
  data: FeatureCollection;
  color: string;
  visible: boolean;
  featureCount: number;
  truncated: boolean;
};

export type ArtworkShapeSelection = {
  floorLabel: string;
  sourceTable: string;
  sourceRow: number;
  feature: Feature<OutlineGeometry>;
};

export function buildShapeMatchOverlay(
  selection: ArtworkShapeSelection | null,
  currentTransform: SimilarityTransform | null,
  preview?: {
    suggestion: IllustratorShapeMatchSuggestion;
    transform: SimilarityTransform;
  } | null
): FeatureCollection {
  const features: Feature[] = [];

  if (selection && currentTransform) {
    const selected = transformGeoJson(
      { type: "FeatureCollection", features: [selection.feature] },
      currentTransform
    ).features[0];
    if (selected?.geometry) {
      features.push({
        type: "Feature",
        properties: { kind: "selected" },
        geometry: selected.geometry
      });
    }
  }

  if (preview) {
    features.push({
      type: "Feature",
      properties: {
        kind: "reference",
        rank: preview.suggestion.rank,
        label: `#${preview.suggestion.rank}`
      },
      geometry: preview.suggestion.reference_geometry
    });

    if (selection) {
      const proposed = transformGeoJson(
        { type: "FeatureCollection", features: [selection.feature] },
        preview.transform
      ).features[0];
      if (proposed?.geometry) {
        features.push({
          type: "Feature",
          properties: { kind: "preview" },
          geometry: proposed.geometry
        });
      }
    }

    features.push(
      ...preview.suggestion.residual_vectors.map((vector) => ({
        type: "Feature" as const,
        properties: { kind: "residual", distance_m: vector.distance_m },
        geometry: {
          type: "LineString" as const,
          coordinates: [vector.artwork, vector.reference]
        }
      }))
    );
  }

  return { type: "FeatureCollection", features };
}

function geometryBounds(geometry: Geometry): [[number, number], [number, number]] | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const position of geometryPositions(geometry)) {
    const [x, y] = position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX)
    ? [
        [minX, minY],
        [maxX, maxY]
      ]
    : null;
}

export type RegionCorners = [number, number][];

/** The two picked areas, drawn so the asserted correspondence stays visible. */
export function buildRegionOverlay(
  source: RegionCorners | null,
  target: RegionCorners | null
): FeatureCollection {
  const features: Feature[] = [];
  const push = (corners: RegionCorners | null, kind: string) => {
    if (!corners || corners.length < 3) return;
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: { type: "Polygon", coordinates: [[...corners, corners[0]]] }
    });
  };
  push(source, "region-source");
  push(target, "region-target");
  return { type: "FeatureCollection", features };
}

/**
 * Nearest rendered vertex of the given layers to a screen point, as lngLat, or
 * null when nothing renders within the tolerance. Vertices are compared in
 * screen space, so the tolerance means pixels regardless of zoom.
 */
function nearestRenderedVertex(
  instance: MaplibreMap,
  layerIds: string[],
  point: { x: number; y: number },
  tolerancePx: number
): [number, number] | null {
  const layers = layerIds.filter((id) => instance.getLayer(id));
  if (!layers.length) return null;
  const features = instance.queryRenderedFeatures(
    [
      [point.x - tolerancePx, point.y - tolerancePx],
      [point.x + tolerancePx, point.y + tolerancePx]
    ],
    { layers }
  );
  const lngLats: [number, number][] = [];
  const screenPts: [number, number][] = [];
  for (const feature of features) {
    if (!feature.geometry) continue;
    for (const coord of geometryPositions(feature.geometry)) {
      const screen = instance.project(coord as [number, number]);
      lngLats.push([coord[0], coord[1]]);
      screenPts.push([screen.x, screen.y]);
    }
  }
  const hit = nearestVertex(screenPts, [point.x, point.y], tolerancePx);
  // nearestVertex returns the same tuple reference, so indexOf finds the pair.
  return hit ? lngLats[screenPts.indexOf(hit)] : null;
}

function raiseFloorToTop(instance: MaplibreMap, label: string): void {
  try {
    const slot = instance.getLayer(OVERLAY_SLOT_LAYER_ID);
    if (!slot) return;
    for (const id of [floorFillLayerId(label), floorLineLayerId(label)]) {
      if (instance.getLayer(id)) {
        instance.moveLayer(id, OVERLAY_SLOT_LAYER_ID);
      }
    }
  } catch {
    // Style may be swapping when the map remounts; the next load retries.
  }
}

type Props = {
  floors: FloorLayer[];
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  /** What drags and handles act on: the whole linked group or the active floor. */
  mode: AdjustmentMode;
  onModeChange: (mode: AdjustmentMode) => void;
  /** Pair-picking stage; null when no control-point pair is being picked. */
  pickStage: "artwork" | "map" | null;
  /** The pinned artwork half of the in-progress pair, awaiting its map click. */
  pendingArtwork?: [number, number] | null;
  onPickArtwork: (pt: [number, number]) => void;
  onPickMap: (lngLat: [number, number]) => void;
  /** Fly here when it changes; set by an address search, never by dragging. */
  recenterTo?: [number, number] | null;
  referenceLayers?: ReferenceLayer[];
  shapePickActive?: boolean;
  selectedShape?: ArtworkShapeSelection | null;
  shapeMatchPreview?: {
    suggestion: IllustratorShapeMatchSuggestion;
    transform: SimilarityTransform;
  } | null;
  onPickShape?: (selection: ArtworkShapeSelection) => void;
  /** Which area is being drawn: the active floor's, then the target floor's. */
  regionPickStage?: "source" | "target" | null;
  regionSource?: RegionCorners | null;
  regionTarget?: RegionCorners | null;
  onRegionDrawn?: (corners: RegionCorners) => void;
  /** False while the pin or Station_pg snap is still in flight. */
  artworkVisible?: boolean;
};

/**
 * Placement map: the selected floor over ghosts of the others, optional
 * reference overlays beneath both, a floor picker, and transform handles for
 * the active floor only.
 */
export function PlacementMap({
  floors,
  state,
  dispatch,
  mode,
  onModeChange,
  pickStage,
  pendingArtwork = null,
  onPickArtwork,
  onPickMap,
  recenterTo,
  referenceLayers = [],
  shapePickActive = false,
  selectedShape = null,
  shapeMatchPreview = null,
  onPickShape,
  regionPickStage = null,
  regionSource = null,
  regionTarget = null,
  onRegionDrawn,
  artworkVisible = true
}: Props) {
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [basemapOpen, setBasemapOpen] = useState(false);
  const [view, setView] = useState<ArtworkView>(DEFAULT_ARTWORK_VIEW);
  const [artworkLayersOpen, setArtworkLayersOpen] = useState(false);
  const [hiddenArtworkLayers, setHiddenArtworkLayers] = useState<Record<string, string[]>>({});
  const [rubber, setRubber] = useState<
    { x0: number; y0: number; x1: number; y1: number } | null
  >(null);
  const mapStyle = useMemo(
    () => ({ ...BASEMAP_STYLES[basemap], glyphs: PLACEMENT_GLYPHS }),
    [basemap]
  );
  const artworkLayerGroups = useMemo(() => summarizeArtworkLayers(floors), [floors]);
  const hiddenArtworkLayerCount = artworkLayerGroups.reduce(
    (count, floor) =>
      count +
      floor.layers.filter((layer) =>
        (hiddenArtworkLayers[floor.floorLabel] ?? []).includes(layer.name)
      ).length,
    0
  );

  const activeFloor =
    state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeLayer = floors.find((f) => f.label === activeFloor?.label) ?? floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;

  const setArtworkLayerVisible = (floorLabel: string, layerName: string, visible: boolean) => {
    setHiddenArtworkLayers((current) => {
      const next = new Set(current[floorLabel] ?? []);
      if (visible) next.delete(layerName);
      else next.add(layerName);
      if (next.size > 0) return { ...current, [floorLabel]: [...next] };
      const remaining = { ...current };
      delete remaining[floorLabel];
      return remaining;
    });
  };

  const setFloorArtworkLayersVisible = (
    floorLabel: string,
    layerNames: string[],
    visible: boolean
  ) => {
    setHiddenArtworkLayers((current) => {
      if (!visible) return { ...current, [floorLabel]: layerNames };
      const remaining = { ...current };
      delete remaining[floorLabel];
      return remaining;
    });
  };

  // initialViewState only applies on mount, so a search result would otherwise
  // move the artwork off-screen while the camera stayed put.
  useEffect(() => {
    if (!ready || !recenterTo) return;
    mapRef.current?.easeTo({ center: recenterTo, duration: 600 });
  }, [ready, recenterTo]);

  // The selected floor is drawn in full; the others stay as a faint ghost
  // underneath, so stacked plans can be aligned against each other without
  // competing for attention with the floor the handles act on.
  const placedByFloor = useMemo(
    () =>
      floors.map((floor) => {
        const floorState = state.floors.find((f) => f.label === floor.label);
        const transform = floorState ? resolvedTransform(state, floorState) : null;
        return {
          label: floor.label,
          color: floor.color,
          data: transform
            ? transformGeoJson(
                { type: "FeatureCollection", features: floor.features } satisfies FeatureCollection,
                transform
              )
            : EMPTY_FEATURE_COLLECTION
        };
      }),
    [floors, state]
  );

  const activeLabel = activeFloor?.label ?? null;

  // Keep the active floor on top of the ghosts without remounting sources.
  // moveLayer is a no-op when the layer is already in place.
  useEffect(() => {
    if (!ready || !activeLabel) return;
    const instance = mapRef.current?.getMap();
    if (!instance) return;
    raiseFloorToTop(instance, activeLabel);
  }, [ready, activeLabel]);

  const gizmo = useMemo(
    () =>
      activeFloor && activeTransform
        ? gizmoFrame(activeTransform, activeFloor.artworkBounds)
        : null,
    [activeFloor, activeTransform]
  );

  const controlPointData = useMemo(
    () =>
      activeFloor && activeTransform
        ? buildControlPointOverlay(activeFloor.controlPoints, activeTransform)
        : EMPTY_FEATURE_COLLECTION,
    [activeFloor, activeTransform]
  );

  const shapeMatchData = useMemo(
    () => buildShapeMatchOverlay(selectedShape, activeTransform, shapeMatchPreview),
    [selectedShape, activeTransform, shapeMatchPreview]
  );
  const previewGeometry = shapeMatchPreview?.suggestion.reference_geometry ?? null;
  const previewRank = shapeMatchPreview?.suggestion.rank ?? null;

  useEffect(() => {
    if (!ready || !previewGeometry) return;
    const bounds = geometryBounds(previewGeometry);
    if (!bounds) return;
    mapRef.current?.fitBounds(bounds, { padding: 72, duration: 350, maxZoom: 19 });
  }, [ready, previewGeometry, previewRank]);

  const regionData = useMemo(
    () => buildRegionOverlay(regionSource, regionTarget),
    [regionSource, regionTarget]
  );

  const onClick = (event: MapLayerMouseEvent) => {
    const instance = mapRef.current?.getMap();
    if (shapePickActive) {
      if (!instance || !activeFloor || !activeLayer || !onPickShape) return;
      const fillLayerId = floorFillLayerId(activeFloor.label);
      const lineLayerId = floorLineLayerId(activeFloor.label);
      const fillLayers = instance.getLayer(fillLayerId) ? [fillLayerId] : [];
      const lineLayers = instance.getLayer(lineLayerId) ? [lineLayerId] : [];
      if (!fillLayers.length && !lineLayers.length) return;
      const { x, y } = event.point;
      const exactFill = fillLayers.length
        ? instance.queryRenderedFeatures([x, y], { layers: fillLayers })
        : [];
      const nearby = instance.queryRenderedFeatures(
        [
          [x - SNAP_PX, y - SNAP_PX],
          [x + SNAP_PX, y + SNAP_PX]
        ],
        { layers: [...fillLayers, ...lineLayers] }
      );
      const feature = resolvePickedOutline(exactFill, nearby, activeLayer.features);
      if (!feature) return;
      onPickShape({
        floorLabel: activeFloor.label,
        sourceTable: String(feature.properties?.source_table),
        sourceRow: Number(feature.properties?.source_row),
        feature
      });
      return;
    }
    if (!pickStage) return;
    if (pickStage === "artwork") {
      // Pin an artwork point: the click must land on the active floor's plan.
      if (!instance || !activeFloor || !activeTransform) return;
      const bodyIds = [
        floorFillLayerId(activeFloor.label),
        floorLineLayerId(activeFloor.label)
      ];
      const snapped = nearestRenderedVertex(instance, bodyIds, event.point, SNAP_PX);
      if (!snapped) {
        const layers = bodyIds.filter((id) => instance.getLayer(id));
        const onPlan =
          layers.length > 0 &&
          instance.queryRenderedFeatures([event.point.x, event.point.y], { layers }).length > 0;
        if (!onPlan) return;
      }
      const lngLat = snapped ?? [event.lngLat.lng, event.lngLat.lat];
      onPickArtwork(artworkFromLngLat(activeTransform, lngLat));
      return;
    }
    // Map side: snap to a reference-layer vertex when one is near.
    const referenceIds = referenceLayers
      .filter((layer) => layer.visible)
      .flatMap((layer) => [
        referenceFillLayerId(layer.name),
        referenceLineLayerId(layer.name),
        referencePointLayerId(layer.name)
      ]);
    const snapped = instance
      ? nearestRenderedVertex(instance, referenceIds, event.point, SNAP_PX)
      : null;
    onPickMap(snapped ?? [event.lngLat.lng, event.lngLat.lat]);
  };

  // Bottom-left read-out. Updated on moveEnd rather than move: a pan fires move
  // every frame, and re-rendering this map on every frame to retitle a label is
  // not a trade worth making.
  const [center, setCenter] = useState<[number, number] | null>(null);

  /**
   * Frame the active floor.
   *
   * The artwork routinely sits as a small shape on a very large basemap with no
   * way back to it; panning to find your own drawing was the most common way to
   * get lost on this screen.
   */
  const zoomToArtwork = () => {
    const instance = mapRef.current?.getMap();
    const active = placedByFloor.find((floor) => floor.label === activeLabel);
    if (!instance || !active) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const walk = (coords: unknown): void => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        const [x, y] = coords as [number, number];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return;
      }
      for (const part of coords) walk(part);
    };
    for (const feature of active.data.features) walk((feature.geometry as { coordinates?: unknown })?.coordinates);
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
    instance.fitBounds(
      [
        [minX, minY],
        [maxX, maxY]
      ],
      { padding: 72, duration: 600, maxZoom: 20 }
    );
  };

  // The pinned artwork half of the pair follows the active floor's transform.
  const pendingMarkerLngLat =
    pickStage === "map" && pendingArtwork && activeTransform
      ? artworkToLngLat(activeTransform, pendingArtwork[0], pendingArtwork[1])
      : null;

  return (
    <div className="relative h-full w-full">
      <MapView
        ref={mapRef}
        initialViewState={{
          longitude: activeTransform?.mapAnchor[0] ?? 139.7671,
          latitude: activeTransform?.mapAnchor[1] ?? 35.6812,
          zoom: 17
        }}
        mapStyle={mapStyle}
        style={{ width: "100%", height: "100%" }}
        onLoad={(event) => {
          if (activeLabel) {
            raiseFloorToTop(event.target, activeLabel);
          }
          setReady(true);
        }}
        onRemove={() => setReady(false)}
        onMoveEnd={(event) =>
          setCenter([event.viewState.longitude, event.viewState.latitude])
        }
        onClick={onClick}
        cursor={shapePickActive || pickStage ? "crosshair" : undefined}
      >
        {/* Stable slots so beforeId never names a layer that just unmounted. */}
        <Source id={ARTWORK_SLOT_SOURCE_ID} type="geojson" data={EMPTY_FEATURE_COLLECTION}>
          <Layer id={ARTWORK_SLOT_LAYER_ID} type="fill" paint={{ "fill-opacity": 0 }} />
        </Source>
        <Source id={OVERLAY_SLOT_SOURCE_ID} type="geojson" data={EMPTY_FEATURE_COLLECTION}>
          <Layer id={OVERLAY_SLOT_LAYER_ID} type="fill" paint={{ "fill-opacity": 0 }} />
        </Source>

        {/* Reference data sits under everything the user is placing. Hidden
            layers stay mounted: unmounting a large shapefile source reallocates
            GPU buffers and used to blank the map. */}
        {referenceLayers.map((layer) => (
          <Source
            key={referenceSourceId(layer.name)}
            id={referenceSourceId(layer.name)}
            type="geojson"
            data={layer.data}
          >
            <Layer
              id={referenceFillLayerId(layer.name)}
              type="fill"
              beforeId={ARTWORK_SLOT_LAYER_ID}
              filter={["==", ["geometry-type"], "Polygon"]}
              layout={{ visibility: layerVisibility(layer.visible) }}
              paint={{ "fill-color": layer.color, "fill-opacity": 0.08 }}
            />
            <Layer
              id={referenceLineLayerId(layer.name)}
              type="line"
              beforeId={ARTWORK_SLOT_LAYER_ID}
              layout={{ visibility: layerVisibility(layer.visible) }}
              paint={{
                "line-color": layer.color,
                "line-width": 1.2,
                "line-opacity": 0.9,
                // Dashed reads as "reference", never as artwork being placed.
                "line-dasharray": [2, 1]
              }}
            />
            <Layer
              id={referencePointLayerId(layer.name)}
              type="circle"
              beforeId={ARTWORK_SLOT_LAYER_ID}
              filter={["==", ["geometry-type"], "Point"]}
              layout={{ visibility: layerVisibility(layer.visible) }}
              paint={{ "circle-radius": 3, "circle-color": layer.color }}
            />
          </Source>
        ))}

        {/* One source per floor for the life of the map. Active vs ghost is
            paint + visibility, never a remount — swapping React keys while
            reusing the MapLibre source id is what went white. */}
        {placedByFloor.map((floor) => {
          const paint = floorPaint(
            floor.label === activeLabel ? "active" : "other",
            view,
            floor.color,
            isImageryBasemap(basemap)
          );
          const hiddenLayers = hiddenArtworkLayers[floor.label] ?? [];
          const layout = {
            visibility: artworkVisible ? paint.layout.visibility : ("none" as const)
          };
          return (
            <Source
              key={floorSourceId(floor.label)}
              id={floorSourceId(floor.label)}
              type="geojson"
              data={floor.data}
            >
              <Layer
                id={floorFillLayerId(floor.label)}
                type="fill"
                beforeId={OVERLAY_SLOT_LAYER_ID}
                filter={artworkLayerFilter(hiddenLayers, true)}
                layout={layout}
                paint={paint.fill}
              />
              <Layer
                id={floorLineLayerId(floor.label)}
                type="line"
                beforeId={OVERLAY_SLOT_LAYER_ID}
                filter={artworkLayerFilter(hiddenLayers)}
                layout={layout}
                paint={paint.line}
              />
            </Source>
          );
        })}

        {pendingMarkerLngLat && activeFloor ? (
          <Marker
            longitude={pendingMarkerLngLat[0]}
            latitude={pendingMarkerLngLat[1]}
            anchor="center"
          >
            <div
              aria-label={t(
                `Artwork point ${activeFloor.controlPoints.length + 1}`,
                `図面上の点 ${activeFloor.controlPoints.length + 1}`
              )}
              className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white shadow"
              style={{ backgroundColor: OVERLAY_COLORS.artwork }}
            >
              {activeFloor.controlPoints.length + 1}
            </div>
          </Marker>
        ) : null}

        <Source id="placement-control-points" type="geojson" data={controlPointData}>
          <Layer
            id="placement-control-point-residuals"
            type="line"
            filter={["==", ["get", "kind"], "residual"]}
            paint={{ "line-color": OVERLAY_COLORS.residual, "line-width": 2 }}
          />
          <Layer
            id="placement-control-point-artwork"
            type="circle"
            filter={["==", ["get", "kind"], "artwork"]}
            paint={{
              "circle-radius": 5,
              "circle-color": OVERLAY_COLORS.artwork,
              "circle-stroke-color": OVERLAY_COLORS.halo,
              "circle-stroke-width": 2
            }}
          />
          <Layer
            id="placement-control-point-reference"
            type="circle"
            filter={["==", ["get", "kind"], "reference"]}
            paint={{
              "circle-radius": 6,
              "circle-color": OVERLAY_COLORS.reference,
              "circle-stroke-color": OVERLAY_COLORS.halo,
              "circle-stroke-width": 2
            }}
          />
          <Layer
            id="placement-control-point-labels"
            type="symbol"
            filter={["==", ["get", "kind"], "reference"]}
            layout={{
              "text-field": ["get", "label"],
              "text-font": ["Open Sans Semibold"],
              "text-size": 10,
              "text-anchor": "center",
              "text-allow-overlap": true
            }}
            paint={{ "text-color": OVERLAY_COLORS.halo }}
          />
        </Source>

        <Source id="placement-shape-match" type="geojson" data={shapeMatchData}>
          <Layer
            id="placement-shape-match-residuals"
            type="line"
            filter={["==", ["get", "kind"], "residual"]}
            paint={{ "line-color": OVERLAY_COLORS.residual, "line-width": 1.5, "line-opacity": 0.9 }}
          />
          <Layer
            id="placement-shape-match-selected-fill"
            type="fill"
            filter={["==", ["get", "kind"], "selected"]}
            paint={{ "fill-color": "#2563eb", "fill-opacity": 0.04 }}
          />
          <Layer
            id="placement-shape-match-selected-line"
            type="line"
            filter={["==", ["get", "kind"], "selected"]}
            paint={{
              "line-color": "#2563eb",
              "line-width": 2,
              "line-opacity": 0.7,
              "line-dasharray": [2, 1]
            }}
          />
          <Layer
            id="placement-shape-match-reference-fill"
            type="fill"
            filter={["==", ["get", "kind"], "reference"]}
            paint={{ "fill-color": WARNING_MAP_COLORS.stroke, "fill-opacity": 0.2 }}
          />
          <Layer
            id="placement-shape-match-reference-line"
            type="line"
            filter={["==", ["get", "kind"], "reference"]}
            paint={{ "line-color": WARNING_MAP_COLORS.stroke, "line-width": 3 }}
          />
          <Layer
            id="placement-shape-match-reference-label"
            type="symbol"
            filter={["==", ["get", "kind"], "reference"]}
            layout={{
              "text-field": ["get", "label"],
              "text-font": ["Open Sans Semibold"],
              "text-size": 12,
              "text-allow-overlap": true,
              "text-ignore-placement": true
            }}
            paint={{
              "text-color": WARNING_MAP_COLORS.text,
              "text-halo-color": WARNING_MAP_COLORS.halo,
              "text-halo-width": 3
            }}
          />
          <Layer
            id="placement-shape-match-preview-fill"
            type="fill"
            filter={["==", ["get", "kind"], "preview"]}
            paint={{ "fill-color": "#2563eb", "fill-opacity": 0.16 }}
          />
          <Layer
            id="placement-shape-match-preview-line"
            type="line"
            filter={["==", ["get", "kind"], "preview"]}
            paint={{ "line-color": "#2563eb", "line-width": 3 }}
          />
        </Source>

        <Source id="placement-regions" type="geojson" data={regionData}>
          <Layer
            id="placement-region-fill"
            type="fill"
            paint={{
              "fill-color": [
                "case",
                ["==", ["get", "kind"], "region-source"],
                "#2563eb",
                "#f59e0b"
              ],
              "fill-opacity": 0.1
            }}
          />
          <Layer
            id="placement-region-line"
            type="line"
            paint={{
              "line-color": [
                "case",
                ["==", ["get", "kind"], "region-source"],
                "#2563eb",
                "#f59e0b"
              ],
              "line-width": 2,
              "line-dasharray": [2, 1]
            }}
          />
        </Source>

        {/* Bounding box of the active floor: shows what the handles act on. */}
        {gizmo && artworkVisible ? (
          <Source
            id="placement-outline"
            type="geojson"
            data={{
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: gizmo.ring }
            }}
          >
            <Layer
              id="placement-outline-line"
              type="line"
              paint={{
                "line-color": "#334155",
                "line-width": 1,
                "line-opacity": 0.8,
                "line-dasharray": [3, 2]
              }}
            />
          </Source>
        ) : null}

        {ready &&
        artworkVisible &&
        !pickStage &&
        !shapePickActive &&
        !regionPickStage &&
        activeFloor &&
        !activeFloor.pinned &&
        activeTransform &&
        activeLayer &&
        gizmo ? (
          <TransformHandles
            transform={activeTransform}
            frame={gizmo}
            dispatch={dispatch}
            map={mapRef.current}
            floorLabel={activeFloor.label}
            linked={activeFloor.linked}
            mode={mode}
            scaleLocked={state.scaleLocked}
            bodyLayerIds={[
              floorFillLayerId(activeFloor.label),
              floorLineLayerId(activeFloor.label)
            ]}
          />
        ) : null}
      </MapView>

      {/* Drawing captures its own pointer events so the map cannot pan away
          underneath the rubber band. */}
      {regionPickStage ? (
        <div
          data-testid="region-capture"
          className="absolute inset-0 z-10 cursor-crosshair"
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.setPointerCapture(event.pointerId);
            setRubber({
              x0: event.clientX - rect.left,
              y0: event.clientY - rect.top,
              x1: event.clientX - rect.left,
              y1: event.clientY - rect.top
            });
          }}
          onPointerMove={(event) => {
            if (!rubber) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setRubber({
              ...rubber,
              x1: event.clientX - rect.left,
              y1: event.clientY - rect.top
            });
          }}
          onPointerUp={() => {
            const instance = mapRef.current?.getMap();
            const box = rubber;
            setRubber(null);
            if (!instance || !box || !onRegionDrawn) return;
            const left = Math.min(box.x0, box.x1);
            const right = Math.max(box.x0, box.x1);
            const top = Math.min(box.y0, box.y1);
            const bottom = Math.max(box.y0, box.y1);
            // A stray click is not an area; require a deliberate drag.
            if (right - left < 8 || bottom - top < 8) return;
            const corner = (x: number, y: number): [number, number] => {
              const { lng, lat } = instance.unproject([x, y]);
              return [lng, lat];
            };
            onRegionDrawn([
              corner(left, top),
              corner(right, top),
              corner(right, bottom),
              corner(left, bottom)
            ]);
          }}
        >
          {rubber ? (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-[#2563eb] bg-[#2563eb]/10"
              style={{
                left: Math.min(rubber.x0, rubber.x1),
                top: Math.min(rubber.y0, rubber.y1),
                width: Math.abs(rubber.x1 - rubber.x0),
                height: Math.abs(rubber.y1 - rubber.y0)
              }}
            />
          ) : null}
        </div>
      ) : null}

      {/* Above the area-capture layer: switching levels mid-pick is how the
          user gets a clear look at the floor being boxed. */}
      <div className="absolute left-3 top-3 z-20 flex flex-col gap-2">
        <div className="flex flex-wrap gap-1 rounded-md bg-popover/95 p-1 text-popover-foreground shadow-md">
          {floors.map((floor) => {
            const floorState = state.floors.find((item) => item.label === floor.label);
            const linked = floorState?.linked ?? true;
            const pinned = floorState?.pinned ?? false;
            const status = pinned
              ? t("(pinned)", "（固定）")
              : linked
                ? ""
                : t("(unlinked)", "（非連動）");
            return (
              <div key={floor.label} className="flex items-center gap-0.5">
                <Button
                  size="sm"
                  variant={floor.label === state.activeFloorLabel ? "default" : "ghost"}
                  className={cn(
                    floor.label === state.activeFloorLabel &&
                      "bg-signal text-signal-foreground hover:bg-signal/90"
                  )}
                  aria-pressed={floor.label === state.activeFloorLabel}
                  onClick={() => dispatch({ type: "setActiveFloor", label: floor.label })}
                  aria-label={status ? `${floor.label} ${status}` : undefined}
                  title={status ? `${floor.label} ${status}` : floor.label}
                >
                  {pinned ? (
                    <Pin aria-hidden="true" size={10} className="mr-0.5 fill-current" />
                  ) : linked ? null : (
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block h-1 w-1 rounded-full bg-current"
                    />
                  )}
                  {floor.label}
                </Button>
                <Button
                  size="icon"
                  className="h-8 w-8"
                  variant={pinned ? "default" : "ghost"}
                  aria-pressed={pinned}
                  aria-label={t(
                    `${pinned ? "Unpin" : "Pin"} ${floor.label}`,
                    `${floor.label}を${pinned ? "固定解除" : "固定"}`
                  )}
                  title={t(
                    pinned
                      ? `Unpin ${floor.label} to allow placement changes`
                      : `Pin ${floor.label} at its current position`,
                    pinned
                      ? `${floor.label}の固定を解除して位置変更を許可`
                      : `${floor.label}を現在の位置に固定`
                  )}
                  onClick={() =>
                    dispatch({ type: "setFloorPinned", label: floor.label, pinned: !pinned })
                  }
                >
                  <Pin aria-hidden="true" size={12} fill={pinned ? "currentColor" : "none"} />
                </Button>
              </div>
            );
          })}
          {floors.length > 1 ? (
            <>
              <span aria-hidden="true" className="mx-1 w-px self-stretch bg-border" />
              <Button
                size="sm"
                variant={mode === "group" ? "default" : "ghost"}
                aria-pressed={mode === "group"}
                onClick={() => onModeChange("group")}
                title={t(
                  "Drags, rotation and scale move every linked floor together",
                  "ドラッグ・回転・拡大縮小をリンクした全フロアに適用"
                )}
              >
                {t("Group", "グループ")}
              </Button>
              <Button
                size="sm"
                variant={mode === "individual" ? "default" : "ghost"}
                aria-pressed={mode === "individual"}
                onClick={() => onModeChange("individual")}
                title={t(
                  "Drags, rotation and scale adjust the selected floor only",
                  "ドラッグ・回転・拡大縮小を選択中の階だけに適用"
                )}
              >
                {t("Individual", "個別")}
              </Button>
              <span aria-hidden="true" className="mx-1 w-px self-stretch bg-border" />
              <Button
                size="sm"
                variant={view.others === "hidden" ? "default" : "ghost"}
                aria-pressed={view.others === "hidden"}
                onClick={() => setView(toggleOthersHidden)}
                title={t(
                  "Hide the other floors while aligning this one",
                  "この階を合わせる間、他の階を隠す"
                )}
              >
                {t("Only this floor", "この階のみ")}
              </Button>
            </>
          ) : null}
        </div>
        {artworkLayerGroups.some((floor) => floor.layers.length > 0) ? (
          <div className="w-fit">
            <Button
              size="sm"
              variant={artworkLayersOpen ? "default" : "ghost"}
              aria-expanded={artworkLayersOpen}
              aria-controls="placement-artwork-layers"
              aria-label={
                hiddenArtworkLayerCount > 0
                  ? t(
                      `Artwork layers, ${hiddenArtworkLayerCount} hidden`,
                      `アートワークレイヤー、${hiddenArtworkLayerCount}件を非表示`
                    )
                  : t("Artwork layers", "アートワークレイヤー")
              }
              title={t(
                "Show or hide Illustrator layers for each floor",
                "各フロアのIllustratorレイヤーを表示・非表示にする"
              )}
              onClick={() => setArtworkLayersOpen((open) => !open)}
            >
              {t("Layers", "レイヤー")}
              {hiddenArtworkLayerCount > 0 ? (
                <span className="ml-1 rounded-full bg-white/25 px-1.5 text-[10px]">
                  {hiddenArtworkLayerCount}
                </span>
              ) : null}
            </Button>

            {artworkLayersOpen ? (
              <div
                id="placement-artwork-layers"
                className="mt-2 max-h-[55vh] w-72 overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
              >
                <p className="text-xs font-semibold">{t("Artwork layers", "アートワークレイヤー")}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {t(
                    "Hide layers to isolate the area you want to match. Export is unchanged.",
                    "レイヤーを隠して照合したい範囲を見やすくします。書き出しには影響しません。"
                  )}
                </p>

                <div className="mt-3 space-y-3">
                  {artworkLayerGroups
                    .filter((floor) => floor.layers.length > 0)
                    .map((floor, index) => {
                      const hidden = hiddenArtworkLayers[floor.floorLabel] ?? [];
                      const allHidden = floor.layers.every((layer) => hidden.includes(layer.name));
                      const floorHeadingId = `artwork-layer-floor-${index}`;
                      return (
                        <section
                          key={floor.floorLabel}
                          aria-labelledby={floorHeadingId}
                          className="border-t border-border pt-2 first:border-t-0 first:pt-0"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: floor.color }}
                              />
                              <span id={floorHeadingId} className="truncate text-xs font-semibold">
                                {floor.floorLabel}
                              </span>
                              {floor.floorLabel === state.activeFloorLabel ? (
                                <span className="text-[10px] text-muted-foreground">
                                  {t("Active", "選択中")}
                                </span>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className="shrink-0 text-[10px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={t(
                                `${allHidden ? "Show" : "Hide"} all layers on ${floor.floorLabel}`,
                                `${floor.floorLabel} の全レイヤーを${allHidden ? "表示" : "非表示"}`
                              )}
                              onClick={() =>
                                setFloorArtworkLayersVisible(
                                  floor.floorLabel,
                                  floor.layers.map((layer) => layer.name),
                                  allHidden
                                )
                              }
                            >
                              {allHidden ? t("Show all", "すべて表示") : t("Hide all", "すべて非表示")}
                            </button>
                          </div>

                          <ul className="mt-1 space-y-0.5">
                            {floor.layers.map((layer) => {
                              const displayName =
                                layer.name || t("Unlayered artwork", "レイヤーなし");
                              const visible = !hidden.includes(layer.name);
                              return (
                                <li key={layer.name || "__unlayered"}>
                                  <label
                                    className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted ${
                                      visible ? "" : "opacity-55"
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      className="accent-[#2563eb]"
                                      checked={visible}
                                      aria-label={t(
                                        `${displayName} on ${floor.floorLabel}`,
                                        `${floor.floorLabel} の ${displayName}`
                                      )}
                                      onChange={(event) =>
                                        setArtworkLayerVisible(
                                          floor.floorLabel,
                                          layer.name,
                                          event.target.checked
                                        )
                                      }
                                    />
                                    <span className="min-w-0 flex-1 truncate" title={displayName}>
                                      {displayName}
                                    </span>
                                    <span className="text-[10px] tabular-nums text-muted-foreground">
                                      {layer.featureCount}
                                    </span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        </section>
                      );
                    })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Tools, not geometry: things you reach for occasionally sit opposite the
          floor switcher as icons. The basemap had four always-visible chips in
          the prime corner — it is chosen once per session. */}
      <div className="absolute right-3 top-3 z-20 flex gap-0.5 rounded-md bg-popover/95 p-1 text-popover-foreground shadow-md">
        <Popover open={basemapOpen} onOpenChange={setBasemapOpen}>
          <PopoverTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("Basemap", "背景地図")}
              title={basemapLabel(basemap, t)}
            >
              <Layers />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1">
            {BASEMAP_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={id === basemap}
                onClick={() => {
                  setBasemap(id);
                  setBasemapOpen(false);
                }}
                className={cn(
                  "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                  id === basemap
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {basemapLabel(id, t)}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        <Button
          size="icon"
          variant="ghost"
          onClick={zoomToArtwork}
          aria-label={t("Zoom to artwork", "図面にズーム")}
          title={t("Frame the selected floor", "選択中の階に合わせる")}
        >
          <Maximize2 />
        </Button>

        <Button
          size="icon"
          variant={view.active === "transparent" ? "default" : "ghost"}
          aria-pressed={view.active === "transparent"}
          onClick={() => setView(toggleTransparent)}
          aria-label={t("Transparent", "透過表示")}
          title={t(
            "Draw the selected floor as outlines so the map shows through",
            "選択中の階を輪郭だけで描き、下の地図を透かして見る"
          )}
        >
          <Contrast />
        </Button>
      </div>

      {/* Technical marginalia: where you are and in what, without spending a
          panel on it. */}
      {center ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-md bg-popover/95 px-2 py-1 font-mono text-[10px] leading-[14px] tracking-[0.02em] text-popover-foreground shadow-md">
          {center[1].toFixed(6)}, {center[0].toFixed(6)}
          <span className="mx-1 text-muted-foreground">·</span>
          <span className="text-muted-foreground">{state.frame.workingCrs}</span>
        </div>
      ) : null}
    </div>
  );
}
