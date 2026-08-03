import { useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "geojson";
import MapGL, { Layer, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  resolvedTransform,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { transformGeoJson } from "../../lib/similarity";
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

type Props = {
  floors: FloorLayer[];
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  pickingControlPoint: boolean;
  onPickMap: (lngLat: [number, number]) => void;
};

/**
 * Placement map: one tinted GeoJSON source per floor, a floor picker, and
 * transform handles for the active floor only.
 */
export function PlacementMap({ floors, state, dispatch, pickingControlPoint, onPickMap }: Props) {
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>("osm");

  const activeFloor =
    state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeLayer = floors.find((f) => f.label === activeFloor?.label) ?? floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;

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
        {placedByFloor.map((floor) => (
          <Source key={floor.label} id={`floor-${floor.label}`} type="geojson" data={floor.data}>
            <Layer
              id={`floor-${floor.label}-fill`}
              type="fill"
              filter={["==", ["geometry-type"], "Polygon"]}
              paint={{
                "fill-color": ["coalesce", ["get", "fill_color"], floor.color],
                "fill-opacity": 0.45
              }}
            />
            <Layer
              id={`floor-${floor.label}-line`}
              type="line"
              paint={{
                "line-color": ["coalesce", ["get", "stroke_color"], ["get", "fill_color"], floor.color],
                "line-width": 1
              }}
            />
          </Source>
        ))}

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

        <Source
          id="placement-handles"
          type="geojson"
          data={{ type: "FeatureCollection", features: [] }}
        >
          <Layer
            id="placement-handle-circles"
            type="circle"
            paint={{
              "circle-radius": 8,
              "circle-color": [
                "match",
                ["get", "role"],
                "anchor",
                "#2563eb",
                "rotate",
                "#16a34a",
                "#dc2626"
              ],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2
            }}
          />
        </Source>

        {ready && activeFloor && activeTransform && activeLayer ? (
          <TransformHandles
            transform={activeTransform}
            dispatch={dispatch}
            map={mapRef.current}
            artworkBounds={activeFloor.artworkBounds}
            floorLabel={activeFloor.label}
            linked={activeFloor.linked}
            scaleLocked={state.scaleLocked}
          />
        ) : null}
      </MapGL>

      <div className="absolute left-3 top-3 flex flex-col gap-2">
        {floors.length > 1 ? (
          <div className="flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-white/90 p-1 shadow">
            {floors.map((floor) => (
              <Button
                key={floor.label}
                size="sm"
                variant={floor.label === state.activeFloorLabel ? "primary" : "secondary"}
                onClick={() => dispatch({ type: "setActiveFloor", label: floor.label })}
              >
                {floor.label}
              </Button>
            ))}
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
