import { useEffect, useMemo, useRef } from "react";
import { Layer, type MapRef, Source } from "react-map-gl/maplibre";
import { MapView } from "./MapView";
import { STREET_MAP_STYLE } from "./streetMapStyle";
import { featureColorMatchExpr, featureColorMatchTail } from "./featureColors";
import { buildUnitFillColorExpr, buildUnitLineColorExpr, buildUnitOpacityExpr } from "./unitCategoryColors";


export type BasicFeature = {
  type: string;
  feature_type?: string;
  geometry?: {
    type: string;
    coordinates: unknown;
  } | null;
  properties?: {
    source_file?: string;
    [key: string]: unknown;
  };
};

type Props = {
  features: BasicFeature[];
  selectedStem: string | null;
  hoveredStem: string | null;
};


const FILL_LAYER: any = {
  id: "preview-fill",
  type: "fill" as const,
  paint: {
    "fill-color": buildUnitFillColorExpr("feature_type", featureColorMatchTail("fill")),
    "fill-opacity": buildUnitOpacityExpr("feature_type", 0.65, 0.3)
  }
};

const LINE_LAYER: any = {
  id: "preview-line",
  type: "line" as const,
  paint: {
    "line-color": buildUnitLineColorExpr("feature_type", featureColorMatchTail("line")),
    "line-width": 2
  }
};

const POINT_LAYER: any = {
  id: "preview-point",
  type: "circle" as const,
  paint: {
    "circle-color": featureColorMatchExpr("feature_type", "fill"),
    "circle-radius": 4.5,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1
  }
};

const HIGHLIGHT_LINE_LAYER: any = {
  id: "preview-highlight-line",
  type: "line" as const,
  paint: {
    "line-color": "#dc2626",
    "line-width": 4
  }
};

const HIGHLIGHT_FILL_LAYER: any = {
  id: "preview-highlight-fill",
  type: "fill" as const,
  paint: {
    "fill-color": "#ef4444",
    "fill-opacity": 0.25
  }
};


function flattenCoordinates(value: unknown, points: [number, number][]): void {
  if (!Array.isArray(value)) {
    return;
  }
  if (
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    points.push([value[0], value[1]]);
    return;
  }
  value.forEach((entry) => flattenCoordinates(entry, points));
}


function computeBounds(features: BasicFeature[]): [[number, number], [number, number]] | null {
  const points: [number, number][] = [];
  features.forEach((feature) => {
    if (!feature.geometry || !feature.geometry.coordinates) {
      return;
    }
    flattenCoordinates(feature.geometry.coordinates, points);
  });
  if (!points.length) {
    return null;
  }

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat]
  ];
}


export function PreviewMap({ features, selectedStem, hoveredStem }: Props) {
  const mapRef = useRef<MapRef | null>(null);

  const filtered = useMemo(() => {
    if (!selectedStem) {
      return features;
    }
    return features.filter((feature) => feature.properties?.source_file === selectedStem);
  }, [features, selectedStem]);

  const highlighted = useMemo(() => {
    if (!hoveredStem) {
      return [] as BasicFeature[];
    }
    return features.filter((feature) => feature.properties?.source_file === hoveredStem);
  }, [features, hoveredStem]);

  const mapData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: filtered
    }),
    [filtered]
  );

  const highlightData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: highlighted
    }),
    [highlighted]
  );

  // Fit bounds whenever the viewed features change
  useEffect(() => {
    const target = hoveredStem ? highlighted : filtered;
    const bounds = computeBounds(target);
    if (!bounds || !mapRef.current) {
      return;
    }
    mapRef.current.fitBounds(bounds, {
      padding: 32,
      duration: 500
    });
  }, [filtered, highlighted, hoveredStem]);

  // Fit to all features on initial load / map ready
  const initialFitDone = useRef(false);
  const fitToAll = () => {
    if (initialFitDone.current || !features.length || !mapRef.current) return;
    const bounds = computeBounds(features);
    if (!bounds) return;
    mapRef.current.fitBounds(bounds, { padding: 32, duration: 0 });
    initialFitDone.current = true;
  };
  useEffect(() => { fitToAll(); }, [features]);

  return (
    <div className="h-[300px] overflow-hidden rounded-[10px] border border-border">
      <MapView
        ref={mapRef}
        initialViewState={{
          longitude: 139.76,
          latitude: 35.68,
          zoom: 14
        }}
        mapStyle={STREET_MAP_STYLE}
        onLoad={() => fitToAll()}
      >
        <Source id="preview-source" type="geojson" data={mapData}>
          <Layer {...FILL_LAYER} />
          <Layer {...LINE_LAYER} />
          <Layer {...POINT_LAYER} />
        </Source>
        <Source id="preview-highlight-source" type="geojson" data={highlightData}>
          <Layer {...HIGHLIGHT_FILL_LAYER} />
          <Layer {...HIGHLIGHT_LINE_LAYER} />
        </Source>
      </MapView>
    </div>
  );
}
