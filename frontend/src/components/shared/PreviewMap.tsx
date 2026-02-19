import { useEffect, useMemo, useRef } from "react";
import Map, { Layer, MapRef, Source } from "react-map-gl/maplibre";
import { STREET_MAP_STYLE } from "./streetMapStyle";


type BasicFeature = {
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
    "fill-color": [
      "match",
      ["get", "feature_type"],
      "unit",
      "#1d4ed8",
      "opening",
      "#047857",
      "fixture",
      "#7c3aed",
      "detail",
      "#0f766e",
      "level",
      "#475569",
      "#64748b"
    ],
    "fill-opacity": 0.3
  }
};

const LINE_LAYER: any = {
  id: "preview-line",
  type: "line" as const,
  paint: {
    "line-color": [
      "match",
      ["get", "feature_type"],
      "unit",
      "#1d4ed8",
      "opening",
      "#047857",
      "fixture",
      "#7c3aed",
      "detail",
      "#0f766e",
      "level",
      "#475569",
      "#64748b"
    ],
    "line-width": 2
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

  const lons = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)]
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

  return (
    <div className="h-[440px] overflow-hidden rounded border">
      <Map
        ref={mapRef}
        mapLib={import("maplibre-gl")}
        initialViewState={{
          longitude: 139.76,
          latitude: 35.68,
          zoom: 14
        }}
        mapStyle={STREET_MAP_STYLE}
      >
        <Source id="preview-source" type="geojson" data={mapData}>
          <Layer {...FILL_LAYER} />
          <Layer {...LINE_LAYER} />
        </Source>
        <Source id="preview-highlight-source" type="geojson" data={highlightData}>
          <Layer {...HIGHLIGHT_FILL_LAYER} />
          <Layer {...HIGHLIGHT_LINE_LAYER} />
        </Source>
      </Map>
    </div>
  );
}
