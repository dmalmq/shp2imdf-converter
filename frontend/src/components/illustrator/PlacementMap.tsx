import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "geojson";
import MapGL, { Layer, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  resolvedTransform,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { gizmoFrame, transformGeoJson } from "../../lib/similarity";
import {
  BASEMAP_ORDER,
  BASEMAP_STYLES,
  basemapLabel,
  type BasemapId
} from "../shared/basemapStyles";
import { Button } from "../ui";
import { TransformHandles } from "./TransformHandles";

export const FLOOR_TINTS = ["#3b82f6", "#16a34a", "#dc2626", "#9333ea", "#d97706", "#0891b2"];

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

type Props = {
  floors: FloorLayer[];
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  pickingControlPoint: boolean;
  onPickMap: (lngLat: [number, number]) => void;
  /** Fly here when it changes; set by an address search, never by dragging. */
  recenterTo?: [number, number] | null;
  referenceLayers?: ReferenceLayer[];
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
  pickingControlPoint,
  onPickMap,
  recenterTo,
  referenceLayers = []
}: Props) {
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>("osm");

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
            : ({ type: "FeatureCollection", features: [] } satisfies FeatureCollection)
        };
      }),
    [floors, state]
  );

  const activeLabel = activeFloor?.label ?? null;
  const ghostFloors = placedByFloor.filter((floor) => floor.label !== activeLabel);
  const placedActive = placedByFloor.find((floor) => floor.label === activeLabel) ?? null;

  // Reference layers are added after the artwork layers already exist, so they
  // would otherwise be appended on top of it. Anchor them below the bottom-most
  // artwork layer instead.
  const bottomArtworkLayerId = ghostFloors.length
    ? `floor-${ghostFloors[0].label}-ghost-fill`
    : placedActive
      ? `floor-${placedActive.label}-fill`
      : undefined;

  const gizmo = useMemo(
    () =>
      activeFloor && activeTransform
        ? gizmoFrame(activeTransform, activeFloor.artworkBounds)
        : null,
    [activeFloor, activeTransform]
  );

  const controlPointData = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: (activeFloor?.controlPoints ?? []).map((point, index) => ({
        type: "Feature" as const,
        properties: { label: String(index + 1) },
        geometry: { type: "Point" as const, coordinates: point.map }
      }))
    }),
    [activeFloor]
  );

  const onClick = (event: MapLayerMouseEvent) => {
    if (!pickingControlPoint) return;
    onPickMap([event.lngLat.lng, event.lngLat.lat]);
  };

  return (
    <div className="relative h-full w-full">
      <MapGL
        ref={mapRef}
        mapLib={import("maplibre-gl")}
        initialViewState={{
          longitude: activeTransform?.mapAnchor[0] ?? 139.7671,
          latitude: activeTransform?.mapAnchor[1] ?? 35.6812,
          zoom: 17
        }}
        mapStyle={BASEMAP_STYLES[basemap]}
        style={{ width: "100%", height: "100%" }}
        onLoad={() => setReady(true)}
        onClick={onClick}
        cursor={pickingControlPoint ? "crosshair" : undefined}
      >
        {/* Reference data sits under everything the user is placing. */}
        {referenceLayers
          .filter((layer) => layer.visible)
          .map((layer) => (
            <Source
              key={`reference-${layer.name}`}
              id={`reference-${layer.name}`}
              type="geojson"
              data={layer.data}
            >
              <Layer
                id={`reference-${layer.name}-fill`}
                type="fill"
                beforeId={bottomArtworkLayerId}
                filter={["==", ["geometry-type"], "Polygon"]}
                paint={{ "fill-color": layer.color, "fill-opacity": 0.08 }}
              />
              <Layer
                id={`reference-${layer.name}-line`}
                type="line"
                beforeId={bottomArtworkLayerId}
                paint={{
                  "line-color": layer.color,
                  "line-width": 1.2,
                  "line-opacity": 0.9,
                  // Dashed reads as "reference", never as artwork being placed.
                  "line-dasharray": [2, 1]
                }}
              />
              <Layer
                id={`reference-${layer.name}-point`}
                type="circle"
                beforeId={bottomArtworkLayerId}
                filter={["==", ["geometry-type"], "Point"]}
                paint={{ "circle-radius": 3, "circle-color": layer.color }}
              />
            </Source>
          ))}

        {/* Ghosts first so the active floor always draws on top of them. */}
        {ghostFloors.map((floor) => (
          <Source
            key={`ghost-${floor.label}`}
            id={`floor-${floor.label}`}
            type="geojson"
            data={floor.data}
          >
            <Layer
              id={`floor-${floor.label}-ghost-fill`}
              type="fill"
              filter={["==", ["geometry-type"], "Polygon"]}
              paint={{ "fill-color": floor.color, "fill-opacity": 0.06 }}
            />
            <Layer
              id={`floor-${floor.label}-ghost-line`}
              type="line"
              paint={{ "line-color": floor.color, "line-opacity": 0.35, "line-width": 0.5 }}
            />
          </Source>
        ))}

        {placedActive ? (
          <Source
            key={placedActive.label}
            id={`floor-${placedActive.label}`}
            type="geojson"
            data={placedActive.data}
          >
            <Layer
              id={`floor-${placedActive.label}-fill`}
              type="fill"
              filter={["==", ["geometry-type"], "Polygon"]}
              paint={{
                "fill-color": ["coalesce", ["get", "fill_color"], placedActive.color],
                "fill-opacity": 0.45
              }}
            />
            <Layer
              id={`floor-${placedActive.label}-line`}
              type="line"
              paint={{
                "line-color": [
                  "coalesce",
                  ["get", "stroke_color"],
                  ["get", "fill_color"],
                  placedActive.color
                ],
                "line-width": 1
              }}
            />
          </Source>
        ) : null}

        <Source id="placement-control-points" type="geojson" data={controlPointData}>
          <Layer
            id="placement-control-point-circles"
            type="circle"
            paint={{
              "circle-radius": 6,
              "circle-color": "#f59e0b",
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2
            }}
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

        {ready && activeFloor && activeTransform && activeLayer && gizmo ? (
          <TransformHandles
            transform={activeTransform}
            frame={gizmo}
            dispatch={dispatch}
            map={mapRef.current}
            floorLabel={activeFloor.label}
            linked={activeFloor.linked}
            scaleLocked={state.scaleLocked}
            bodyLayerIds={[
              `floor-${activeFloor.label}-fill`,
              `floor-${activeFloor.label}-line`
            ]}
          />
        ) : null}
      </MapGL>

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
