import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon } from "geojson";
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
  type BasemapId
} from "../shared/basemapStyles";
import { Button } from "../ui";
import { TransformHandles } from "./TransformHandles";
import {
  ARTWORK_SLOT_LAYER_ID,
  ARTWORK_SLOT_SOURCE_ID,
  EMPTY_FEATURE_COLLECTION,
  OVERLAY_SLOT_LAYER_ID,
  OVERLAY_SLOT_SOURCE_ID,
  floorFillLayerId,
  floorLineLayerId,
  floorSourceId,
  layerVisibility,
  referenceFillLayerId,
  referenceLineLayerId,
  referencePointLayerId,
  referenceSourceId
} from "./placementMapLayers";

export const FLOOR_TINTS = ["#3b82f6", "#16a34a", "#dc2626", "#9333ea", "#d97706", "#0891b2"];
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
  selection: ArtworkShapeSelection,
  currentTransform: SimilarityTransform,
  preview?: {
    suggestion: IllustratorShapeMatchSuggestion;
    transform: SimilarityTransform;
  } | null
): FeatureCollection {
  const selected = transformGeoJson(
    { type: "FeatureCollection", features: [selection.feature] },
    currentTransform
  ).features[0];
  if (!selected?.geometry) return { type: "FeatureCollection", features: [] };
  const features: Feature[] = [
    {
      type: "Feature",
      properties: { kind: "selected" },
      geometry: selected.geometry
    }
  ];

  if (preview) {
    const proposed = transformGeoJson(
      { type: "FeatureCollection", features: [selection.feature] },
      preview.transform
    ).features[0];
    if (!proposed?.geometry) return { type: "FeatureCollection", features };
    features.push(
      {
        type: "Feature",
        properties: { kind: "reference" },
        geometry: preview.suggestion.reference_geometry
      },
      {
        type: "Feature",
        properties: { kind: "preview" },
        geometry: proposed.geometry
      },
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
  onPickShape
}: Props) {
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [onlyActiveFloor, setOnlyActiveFloor] = useState(false);
  const mapStyle = useMemo(
    () => ({ ...BASEMAP_STYLES[basemap], glyphs: PLACEMENT_GLYPHS }),
    [basemap]
  );

  const activeFloor =
    state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeLayer = floors.find((f) => f.label === activeFloor?.label) ?? floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;

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
    () =>
      selectedShape && activeTransform
        ? buildShapeMatchOverlay(selectedShape, activeTransform, shapeMatchPreview)
        : EMPTY_FEATURE_COLLECTION,
    [selectedShape, activeTransform, shapeMatchPreview]
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
          const isActive = floor.label === activeLabel;
          const visible = isActive || !onlyActiveFloor;
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
                filter={["==", ["geometry-type"], "Polygon"]}
                layout={{ visibility: layerVisibility(visible) }}
                paint={{
                  "fill-color": isActive
                    ? ["coalesce", ["get", "fill_color"], floor.color]
                    : floor.color,
                  "fill-opacity": isActive ? 0.45 : 0.06
                }}
              />
              <Layer
                id={floorLineLayerId(floor.label)}
                type="line"
                beforeId={OVERLAY_SLOT_LAYER_ID}
                layout={{ visibility: layerVisibility(visible) }}
                paint={{
                  "line-color": isActive
                    ? [
                        "coalesce",
                        ["get", "stroke_color"],
                        ["get", "fill_color"],
                        floor.color
                      ]
                    : floor.color,
                  "line-width": isActive ? 1 : 0.5,
                  "line-opacity": isActive ? 1 : 0.35
                }}
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
              className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-[#2563eb] text-[10px] font-semibold text-white shadow"
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
            paint={{ "line-color": "#dc2626", "line-width": 2 }}
          />
          <Layer
            id="placement-control-point-artwork"
            type="circle"
            filter={["==", ["get", "kind"], "artwork"]}
            paint={{
              "circle-radius": 5,
              "circle-color": "#2563eb",
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2
            }}
          />
          <Layer
            id="placement-control-point-reference"
            type="circle"
            filter={["==", ["get", "kind"], "reference"]}
            paint={{
              "circle-radius": 6,
              "circle-color": "#f59e0b",
              "circle-stroke-color": "#ffffff",
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
            paint={{ "text-color": "#ffffff" }}
          />
        </Source>

        <Source id="placement-shape-match" type="geojson" data={shapeMatchData}>
          <Layer
            id="placement-shape-match-residuals"
            type="line"
            filter={["==", ["get", "kind"], "residual"]}
            paint={{ "line-color": "#dc2626", "line-width": 1.5, "line-opacity": 0.9 }}
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
            paint={{ "fill-color": "#f59e0b", "fill-opacity": 0.14 }}
          />
          <Layer
            id="placement-shape-match-reference-line"
            type="line"
            filter={["==", ["get", "kind"], "reference"]}
            paint={{ "line-color": "#f59e0b", "line-width": 3 }}
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

        {/* Bounding box of the active floor: shows what the handles act on. */}
        {gizmo ? (
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
        !pickStage &&
        !shapePickActive &&
        activeFloor &&
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

      <div className="absolute left-3 top-3 flex flex-col gap-2">
        {floors.length > 1 ? (
          <div className="flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-white/90 p-1 shadow">
            {floors.map((floor) => {
              const linked = state.floors.find((f) => f.label === floor.label)?.linked ?? true;
              return (
                <Button
                  key={floor.label}
                  size="sm"
                  variant={floor.label === state.activeFloorLabel ? "primary" : "secondary"}
                  // The deleted dropdown announced its current value; the
                  // pills are the only floor control now, so the active one
                  // must expose the state, not just the colour.
                  aria-pressed={floor.label === state.activeFloorLabel}
                  onClick={() => dispatch({ type: "setActiveFloor", label: floor.label })}
                  aria-label={
                    linked ? undefined : `${floor.label} ${t("(unlinked)", "（非連動）")}`
                  }
                  title={
                    linked
                      ? floor.label
                      : `${floor.label} ${t("(unlinked)", "（非連動）")}`
                  }
                >
                  {/* A dot, not colour alone, so the state survives a
                      colour-vision deficiency. */}
                  {linked ? null : (
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block h-1 w-1 rounded-full bg-current"
                    />
                  )}
                  {floor.label}
                </Button>
              );
            })}
            <span aria-hidden="true" className="mx-1 w-px self-stretch bg-[var(--color-border)]" />
            {/* What gestures act on: the whole linked group while aligning the
                building as one, or the selected floor for final per-floor
                nudges. Sits with the pills because it pairs with floor switching. */}
            <Button
              size="sm"
              variant={mode === "group" ? "primary" : "secondary"}
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
              variant={mode === "individual" ? "primary" : "secondary"}
              aria-pressed={mode === "individual"}
              onClick={() => onModeChange("individual")}
              title={t(
                "Drags, rotation and scale adjust the selected floor only",
                "ドラッグ・回転・拡大縮小を選択中の階だけに適用"
              )}
            >
              {t("Individual", "個別")}
            </Button>
            <span aria-hidden="true" className="mx-1 w-px self-stretch bg-[var(--color-border)]" />
            {/* Isolating the selected floor sits with the floor pills rather
                than in the sidebar: it is a view option reached for while
                watching the map, exactly like the basemap switcher below. */}
            <Button
              size="sm"
              variant={onlyActiveFloor ? "primary" : "secondary"}
              aria-pressed={onlyActiveFloor}
              onClick={() => setOnlyActiveFloor((only) => !only)}
              title={t(
                "Hide the other floors while aligning this one",
                "この階を合わせる間、他の階を隠す"
              )}
            >
              {t("Only this floor", "この階のみ")}
            </Button>
          </div>
        ) : null}
        <div className="flex gap-1 rounded-[var(--radius-md)] bg-white/90 p-1 shadow">
          {BASEMAP_ORDER.map((id) => (
            <Button
              key={id}
              size="sm"
              variant={id === basemap ? "primary" : "secondary"}
              onClick={() => setBasemap(id)}
            >
              {basemapLabel(id, t)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
