import { useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { transformGeoJson } from "../../lib/similarity";
import {
  BASEMAP_ORDER,
  BASEMAP_STYLES,
  basemapLabel,
  type BasemapId
} from "../shared/basemapStyles";
import { Button } from "../ui";
import { TransformHandles } from "./TransformHandles";

type Props = {
  preview: { type: "FeatureCollection"; features: any[] };
  artworkBounds: [number, number, number, number];
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  pickingControlPoint: boolean;
  onPickMap: (lngLat: [number, number]) => void;
};

export function PlacementMap({
  preview,
  artworkBounds,
  state,
  dispatch,
  pickingControlPoint,
  onPickMap
}: Props) {
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>("osm");

  const placed = useMemo(
    () => transformGeoJson(preview, state.transform),
    [preview, state.transform]
  );

  const controlPointData = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: state.controlPoints.map((point, index) => ({
        type: "Feature" as const,
        properties: { label: String(index + 1) },
        geometry: { type: "Point" as const, coordinates: point.map }
      }))
    }),
    [state.controlPoints]
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
          longitude: state.transform.mapAnchor[0],
          latitude: state.transform.mapAnchor[1],
          zoom: 17
        }}
        mapStyle={BASEMAP_STYLES[basemap]}
        style={{ width: "100%", height: "100%" }}
        onLoad={() => setReady(true)}
        onClick={onClick}
        cursor={pickingControlPoint ? "crosshair" : undefined}
      >
        <Source id="placement-artwork" type="geojson" data={placed}>
          <Layer
            id="placement-artwork-fill"
            type="fill"
            filter={["==", ["geometry-type"], "Polygon"]}
            paint={{
              "fill-color": ["coalesce", ["get", "fill_color"], "#3b82f6"],
              "fill-opacity": 0.45
            }}
          />
          <Layer
            id="placement-artwork-line"
            type="line"
            paint={{
              "line-color": [
                "coalesce",
                ["get", "stroke_color"],
                ["get", "fill_color"],
                "#1d4ed8"
              ],
              "line-width": 1
            }}
          />
        </Source>

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

        {ready ? (
          <TransformHandles
            state={state}
            dispatch={dispatch}
            map={mapRef.current}
            artworkBounds={artworkBounds}
          />
        ) : null}
      </MapGL>

      <div className="absolute left-3 top-3 flex gap-1 rounded-[var(--radius-md)] bg-white/90 p-1 shadow">
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
  );
}
