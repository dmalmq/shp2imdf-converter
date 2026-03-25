import { useEffect, useMemo, useRef } from "react";
import Map, { Layer, type LayerProps, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

import { type ReviewFeature, type ReviewIssue, isLocatedFeature } from "./types";
import { STREET_MAP_STYLE } from "../shared/streetMapStyle";
import { buildUnitFillColorExpr, buildUnitLineColorExpr, buildUnitOpacityExpr } from "../shared/unitCategoryColors";


type Props = {
  features: ReviewFeature[];
  selectedFeatureIds: string[];
  layerVisibility: Record<string, boolean>;
  validationIssues: ReviewIssue[];
  overlayVisibility: Record<string, boolean>;
  levelFilter: string;
  showBasemap: boolean;
  onSelectFeature: (id: string, multi?: boolean) => void;
};


const POLYGON_FILL_LAYER: LayerProps = {
  id: "review-polygons-fill",
  type: "fill",
  filter: ["==", ["geometry-type"], "Polygon"],
  paint: {
    "fill-color": buildUnitFillColorExpr("_feature_type", [
      "venue", "#334155",
      "footprint", "#7c3aed",
      "level", "#2563eb",
      "fixture", "#14b8a6",
      "section", "#0f766e",
      "geofence", "#16a34a",
      "kiosk", "#f97316",
      "facility", "#a855f7",
      "#64748b"
    ]),
    "fill-opacity": buildUnitOpacityExpr("_feature_type", 1.0, 0.7)
  }
} as unknown as LayerProps;

const POLYGON_LINE_LAYER: LayerProps = {
  id: "review-polygons-line",
  type: "line",
  filter: ["==", ["geometry-type"], "Polygon"],
  paint: {
    "line-color": buildUnitLineColorExpr("_feature_type", [
      "venue", "#1e293b",
      "footprint", "#6d28d9",
      "level", "#1d4ed8",
      "fixture", "#0f766e",
      "section", "#0f766e",
      "geofence", "#15803d",
      "kiosk", "#ea580c",
      "facility", "#7e22ce",
      "#475569"
    ]),
    "line-width": 1.5
  }
} as unknown as LayerProps;

const LINE_LAYER: LayerProps = {
  id: "review-lines",
  type: "line",
  filter: ["==", ["geometry-type"], "LineString"],
  paint: {
    "line-color": [
      "match",
      ["get", "_feature_type"],
      "opening",
      "#ea580c",
      "detail",
      "#0f766e",
      "relationship",
      "#7c3aed",
      "#2563eb"
    ],
    "line-width": 2.5
  }
};

const POINT_LAYER: LayerProps = {
  id: "review-points",
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-color": [
      "match",
      ["get", "_feature_type"],
      "amenity",
      "#16a34a",
      "anchor",
      "#2563eb",
      "kiosk",
      "#f97316",
      "facility",
      "#a855f7",
      "#0ea5e9"
    ],
    "circle-radius": 5,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.2
  }
};

const HIGHLIGHT_FILL_LAYER: LayerProps = {
  id: "review-highlight-fill",
  type: "fill",
  filter: ["==", ["geometry-type"], "Polygon"],
  paint: {
    "fill-color": "#ef4444",
    "fill-opacity": 0.2
  }
};

const HIGHLIGHT_LINE_LAYER: LayerProps = {
  id: "review-highlight-line",
  type: "line",
  paint: {
    "line-color": "#dc2626",
    "line-width": 4
  }
};

const HIGHLIGHT_POINT_LAYER: LayerProps = {
  id: "review-highlight-point",
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-color": "#dc2626",
    "circle-radius": 7,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 2
  }
};

const ERROR_OUTLINE_LAYER: LayerProps = {
  id: "review-error-outline",
  type: "line",
  paint: {
    "line-color": "#dc2626",
    "line-width": 3
  }
};

const WARNING_OUTLINE_LAYER: LayerProps = {
  id: "review-warning-outline",
  type: "line",
  paint: {
    "line-color": "#ca8a04",
    "line-width": 2,
    "line-dasharray": [2, 1]
  }
};

const ERROR_POINT_LAYER: LayerProps = {
  id: "review-error-point",
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-color": "#dc2626",
    "circle-radius": 6,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.5
  }
};

const WARNING_POINT_LAYER: LayerProps = {
  id: "review-warning-point",
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-color": "#ca8a04",
    "circle-radius": 6,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.5
  }
};

const OVERLAP_LAYER: LayerProps = {
  id: "review-overlap-fill",
  type: "fill",
  paint: {
    "fill-color": "#ef4444",
    "fill-opacity": 0.28
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


function computeBounds(features: ReviewFeature[]): [[number, number], [number, number]] | null {
  const points: [number, number][] = [];
  features.forEach((feature) => {
    if (!feature.geometry) {
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


function isVisibleByLevel(feature: ReviewFeature, levelFilter: string): boolean {
  if (!levelFilter) {
    return true;
  }
  const levelId = feature.properties.level_id;
  if (typeof levelId === "string" && levelId === levelFilter) {
    return true;
  }
  if (feature.feature_type === "level" && feature.id === levelFilter) {
    return true;
  }
  if (feature.feature_type === "venue" || feature.feature_type === "footprint") {
    return true;
  }
  return false;
}


export function MapPanel({
  features,
  selectedFeatureIds,
  layerVisibility,
  validationIssues,
  overlayVisibility,
  levelFilter,
  showBasemap,
  onSelectFeature
}: Props) {
  const mapRef = useRef<MapRef | null>(null);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer("osm-raster")) return;
    map.setLayoutProperty("osm-raster", "visibility", showBasemap ? "visible" : "none");
  }, [showBasemap]);

  const toGeoJsonFeature = (feature: ReviewFeature) => ({
    type: "Feature" as const,
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      ...feature.properties,
      _feature_type: feature.feature_type,
      _feature_id: feature.id
    }
  });

  const visibleFeatures = useMemo(() => {
    return features.filter((feature) => {
      if (!isLocatedFeature(feature)) {
        return false;
      }
      if ((layerVisibility[feature.feature_type] ?? true) === false) {
        return false;
      }
      return isVisibleByLevel(feature, levelFilter);
    });
  }, [features, layerVisibility, levelFilter]);

  const selectedFeatures = useMemo(() => {
    const selectedSet = new Set(selectedFeatureIds);
    return visibleFeatures.filter((feature) => selectedSet.has(feature.id));
  }, [selectedFeatureIds, visibleFeatures]);

  const errorIds = useMemo(() => {
    return new Set(validationIssues.filter((item) => item.severity === "error" && item.feature_id).map((item) => item.feature_id!));
  }, [validationIssues]);

  const warningIds = useMemo(() => {
    return new Set(validationIssues.filter((item) => item.severity === "warning" && item.feature_id).map((item) => item.feature_id!));
  }, [validationIssues]);

  const errorFeatures = useMemo(() => visibleFeatures.filter((feature) => errorIds.has(feature.id)), [visibleFeatures, errorIds]);
  const warningFeatures = useMemo(
    () => visibleFeatures.filter((feature) => !errorIds.has(feature.id) && warningIds.has(feature.id)),
    [visibleFeatures, errorIds, warningIds]
  );

  const overlapFeatures = useMemo(() => {
    return validationIssues
      .filter((item) => {
        if (item.check !== "overlapping_units" || !item.overlap_geometry) {
          return false;
        }
        const geometry = item.overlap_geometry;
        return typeof geometry === "object" && !Array.isArray(geometry) && typeof geometry.type === "string";
      })
      .map((item, index) => ({
        type: "Feature" as const,
        id: `overlap-${index}`,
        geometry: item.overlap_geometry,
        properties: {
          check: item.check
        }
      }));
  }, [validationIssues]);

  const mapData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: visibleFeatures.map(toGeoJsonFeature)
    }),
    [visibleFeatures]
  );

  const selectedData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: selectedFeatures.map(toGeoJsonFeature)
    }),
    [selectedFeatures]
  );

  const errorData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: errorFeatures.map(toGeoJsonFeature)
    }),
    [errorFeatures]
  );

  const warningData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: warningFeatures.map(toGeoJsonFeature)
    }),
    [warningFeatures]
  );

  const overlapData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: overlapFeatures
    }),
    [overlapFeatures]
  );

  useEffect(() => {
    const target = selectedFeatures.length ? selectedFeatures : visibleFeatures;
    const bounds = computeBounds(target);
    if (!bounds || !mapRef.current) {
      return;
    }
    mapRef.current.fitBounds(bounds, {
      padding: 40,
      duration: 400
    });
  }, [selectedFeatures, visibleFeatures]);

  const onMapClick = (event: MapLayerMouseEvent) => {
    const hit = event.features?.[0];
    if (!hit) {
      return;
    }
    const propertyId =
      hit.properties && typeof hit.properties === "object" ? (hit.properties as Record<string, unknown>)._feature_id : null;
    const resolvedId =
      typeof propertyId === "string"
        ? propertyId
        : typeof hit.id === "string" || typeof hit.id === "number"
          ? String(hit.id)
          : null;
    if (!resolvedId) {
      return;
    }
    onSelectFeature(resolvedId, event.originalEvent.shiftKey);
  };

  return (
    <div className="h-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <Map
        ref={mapRef}
        mapLib={import("maplibre-gl")}
        initialViewState={{
          longitude: 139.76,
          latitude: 35.68,
          zoom: 15
        }}
        interactiveLayerIds={[
          "review-polygons-fill",
          "review-polygons-line",
          "review-lines",
          "review-points",
          "review-highlight-fill",
          "review-highlight-line",
          "review-highlight-point"
        ]}
        mapStyle={STREET_MAP_STYLE}
        onClick={onMapClick}
      >
        <Source id="review-source" type="geojson" data={mapData}>
          <Layer {...POLYGON_FILL_LAYER} />
          <Layer {...POLYGON_LINE_LAYER} />
          <Layer {...LINE_LAYER} />
          <Layer {...POINT_LAYER} />
        </Source>
        <Source id="review-selected-source" type="geojson" data={selectedData}>
          <Layer {...HIGHLIGHT_FILL_LAYER} />
          <Layer {...HIGHLIGHT_LINE_LAYER} />
          <Layer {...HIGHLIGHT_POINT_LAYER} />
        </Source>
        {overlayVisibility.errors !== false ? (
          <Source id="review-errors-source" type="geojson" data={errorData}>
            <Layer {...ERROR_OUTLINE_LAYER} />
            <Layer {...ERROR_POINT_LAYER} />
          </Source>
        ) : null}
        {overlayVisibility.warnings !== false ? (
          <Source id="review-warnings-source" type="geojson" data={warningData}>
            <Layer {...WARNING_OUTLINE_LAYER} />
            <Layer {...WARNING_POINT_LAYER} />
          </Source>
        ) : null}
        {overlayVisibility.overlaps !== false ? (
          <Source id="review-overlap-source" type="geojson" data={overlapData}>
            <Layer {...OVERLAP_LAYER} />
          </Source>
        ) : null}
      </Map>
    </div>
  );
}
