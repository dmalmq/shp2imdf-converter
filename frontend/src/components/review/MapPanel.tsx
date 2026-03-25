import { useEffect, useMemo, useRef } from "react";
import MapGL, { Layer, type LayerProps, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

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
  activeIssue?: ReviewIssue | null;
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

const OVERLAP_UNIT_A_FILL: LayerProps = {
  id: "review-overlap-unit-a-fill",
  type: "fill",
  filter: ["==", ["get", "overlap_role"], "a"],
  paint: {
    "fill-color": "#2563eb",
    "fill-opacity": 0.30
  }
};
const OVERLAP_UNIT_A_LINE: LayerProps = {
  id: "review-overlap-unit-a-line",
  type: "line",
  filter: ["==", ["get", "overlap_role"], "a"],
  paint: {
    "line-color": "#2563eb",
    "line-width": 2.5
  }
};
const OVERLAP_UNIT_B_FILL: LayerProps = {
  id: "review-overlap-unit-b-fill",
  type: "fill",
  filter: ["==", ["get", "overlap_role"], "b"],
  paint: {
    "fill-color": "#ea580c",
    "fill-opacity": 0.30
  }
};
const OVERLAP_UNIT_B_LINE: LayerProps = {
  id: "review-overlap-unit-b-line",
  type: "line",
  filter: ["==", ["get", "overlap_role"], "b"],
  paint: {
    "line-color": "#ea580c",
    "line-width": 2.5
  }
};
const OVERLAP_INTERSECTION_FILL: LayerProps = {
  id: "review-overlap-intersection-fill",
  type: "fill",
  filter: ["==", ["get", "overlap_role"], "intersection"],
  paint: {
    "fill-color": "#ef4444",
    "fill-opacity": 0.35
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
  activeIssue,
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

  const selectedSet = useMemo(() => new Set(selectedFeatureIds), [selectedFeatureIds]);
  const hasSelection = selectedFeatureIds.length > 0;

  const selectedFeatures = useMemo(() => {
    return visibleFeatures.filter((feature) => selectedSet.has(feature.id));
  }, [selectedSet, visibleFeatures]);

  const errorIds = useMemo(() => {
    return new Set(validationIssues.filter((item) => item.severity === "error" && item.feature_id).map((item) => item.feature_id!));
  }, [validationIssues]);

  const warningIds = useMemo(() => {
    return new Set(validationIssues.filter((item) => item.severity === "warning" && item.feature_id).map((item) => item.feature_id!));
  }, [validationIssues]);

  // When features are selected, only show error/warning overlays for those features.
  // When an active issue is set, narrow further to just that issue's feature.
  const errorFeatures = useMemo(() => {
    if (activeIssue) {
      if (activeIssue.check === "overlapping_units") return [];
      if (activeIssue.severity !== "error") return [];
      const targetId = activeIssue.feature_id;
      return targetId ? visibleFeatures.filter((f) => f.id === targetId) : [];
    }
    const pool = hasSelection
      ? visibleFeatures.filter((f) => selectedSet.has(f.id) && errorIds.has(f.id))
      : visibleFeatures.filter((f) => errorIds.has(f.id));
    return pool;
  }, [visibleFeatures, errorIds, hasSelection, selectedSet, activeIssue]);

  const warningFeatures = useMemo(() => {
    if (activeIssue) {
      if (activeIssue.check === "overlapping_units") return [];
      if (activeIssue.severity !== "warning") return [];
      const targetId = activeIssue.feature_id;
      return targetId ? visibleFeatures.filter((f) => f.id === targetId) : [];
    }
    const pool = hasSelection
      ? visibleFeatures.filter((f) => selectedSet.has(f.id) && !errorIds.has(f.id) && warningIds.has(f.id))
      : visibleFeatures.filter((f) => !errorIds.has(f.id) && warningIds.has(f.id));
    return pool;
  }, [visibleFeatures, errorIds, warningIds, hasSelection, selectedSet, activeIssue]);

  // When a feature is selected, show both full overlapping units with distinct colors.
  // When nothing is selected, show all overlap intersection areas (overview mode).
  // When an active issue is set, show only that specific overlap pair.
  const overlapFeatures = useMemo(() => {
    const overlapIssues = validationIssues.filter(
      (item) => item.check === "overlapping_units" && item.overlap_geometry &&
        typeof item.overlap_geometry === "object" && !Array.isArray(item.overlap_geometry) &&
        typeof (item.overlap_geometry as Record<string, unknown>).type === "string"
    );

    if (activeIssue) {
      // Active issue mode: show only the specific overlap pair, or nothing if not an overlap issue
      if (activeIssue.check !== "overlapping_units") return [];
      const match = overlapIssues.find(
        (item) => item.feature_id === activeIssue.feature_id && item.related_feature_id === activeIssue.related_feature_id
      );
      if (!match) return [];

      const featureMap = new Map(features.map((f) => [f.id, f]));
      const result: Array<Record<string, unknown>> = [];
      const unitA = match.feature_id ? featureMap.get(match.feature_id) : null;
      const unitB = match.related_feature_id ? featureMap.get(match.related_feature_id) : null;
      if (unitA?.geometry) {
        result.push({ type: "Feature", geometry: unitA.geometry, properties: { overlap_role: "a" } });
      }
      if (unitB?.geometry) {
        result.push({ type: "Feature", geometry: unitB.geometry, properties: { overlap_role: "b" } });
      }
      result.push({ type: "Feature", geometry: match.overlap_geometry, properties: { overlap_role: "intersection" } });
      return result;
    }

    if (!hasSelection) {
      // Overview: just show intersection polygons
      return overlapIssues.map((item) => ({
        type: "Feature",
        geometry: item.overlap_geometry,
        properties: { overlap_role: "intersection" }
      }));
    }

    // Selection mode: show full unit geometries + intersection for selected overlaps
    const featureMap = new Map(features.map((f) => [f.id, f]));
    const result: Array<Record<string, unknown>> = [];
    const seenPairs = new Set<string>();

    for (const item of overlapIssues) {
      if (!item.feature_id || !selectedSet.has(item.feature_id) || !item.related_feature_id) continue;
      const pairKey = [item.feature_id, item.related_feature_id].sort().join("_");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const unitA = featureMap.get(item.feature_id);
      const unitB = featureMap.get(item.related_feature_id);

      if (unitA?.geometry) {
        result.push({ type: "Feature", geometry: unitA.geometry, properties: { overlap_role: "a" } });
      }
      if (unitB?.geometry) {
        result.push({ type: "Feature", geometry: unitB.geometry, properties: { overlap_role: "b" } });
      }
      result.push({ type: "Feature", geometry: item.overlap_geometry, properties: { overlap_role: "intersection" } });
    }
    return result;
  }, [validationIssues, hasSelection, selectedSet, features, activeIssue]);

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

  // Zoom to the active issue's feature(s) when one is selected
  useEffect(() => {
    if (!activeIssue || !mapRef.current) return;
    const targetIds = [activeIssue.feature_id, activeIssue.related_feature_id].filter(Boolean) as string[];
    const targetFeatures = features.filter((f) => targetIds.includes(f.id));
    const bounds = computeBounds(targetFeatures);
    if (bounds) {
      mapRef.current.fitBounds(bounds, { padding: 60, duration: 400 });
    }
  }, [activeIssue, features]);

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
      <MapGL
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
            {hasSelection || activeIssue ? (
              <>
                <Layer {...OVERLAP_UNIT_A_FILL} />
                <Layer {...OVERLAP_UNIT_A_LINE} />
                <Layer {...OVERLAP_UNIT_B_FILL} />
                <Layer {...OVERLAP_UNIT_B_LINE} />
                <Layer {...OVERLAP_INTERSECTION_FILL} />
              </>
            ) : (
              <Layer {...OVERLAP_LAYER} />
            )}
          </Source>
        ) : null}
      </MapGL>
    </div>
  );
}
