import { useEffect, useMemo, useRef } from "react";
import Map, { Layer, type LayerProps, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

import { type ReviewFeature, type ReviewIssue, isLocatedFeature } from "./types";
import { STREET_MAP_STYLE } from "../shared/streetMapStyle";


type Props = {
  features: ReviewFeature[];
  selectedFeatureIds: string[];
  layerVisibility: Record<string, boolean>;
  validationIssues: ReviewIssue[];
  overlayVisibility: Record<string, boolean>;
  levelFilter: string;
  onSelectFeature: (id: string, multi?: boolean) => void;
};


const POLYGON_FILL_LAYER: LayerProps = {
  id: "review-polygons-fill",
  type: "fill",
  filter: ["in", ["get", "_feature_type"], ["literal", ["venue", "footprint", "level", "unit", "fixture"]]],
  paint: {
    "fill-color": [
      "match",
      ["get", "_feature_type"],
      "venue",
      "#334155",
      "footprint",
      "#7c3aed",
      "level",
      "#2563eb",
      "unit",
      "#0ea5e9",
      "fixture",
      "#14b8a6",
      "#64748b"
    ],
    "fill-opacity": 0.35
  }
};

const POLYGON_LINE_LAYER: LayerProps = {
  id: "review-polygons-line",
  type: "line",
  filter: ["in", ["get", "_feature_type"], ["literal", ["venue", "footprint", "level", "unit", "fixture"]]],
  paint: {
    "line-color": [
      "match",
      ["get", "_feature_type"],
      "venue",
      "#1e293b",
      "footprint",
      "#6d28d9",
      "level",
      "#1d4ed8",
      "unit",
      "#0284c7",
      "fixture",
      "#0f766e",
      "#475569"
    ],
    "line-width": 1.5
  }
};

const OPENING_LAYER: LayerProps = {
  id: "review-openings",
  type: "line",
  filter: ["==", ["get", "_feature_type"], "opening"],
  paint: {
    "line-color": "#ea580c",
    "line-width": 2.5
  }
};

const DETAIL_LAYER: LayerProps = {
  id: "review-details",
  type: "line",
  filter: ["==", ["get", "_feature_type"], "detail"],
  paint: {
    "line-color": "#0f766e",
    "line-width": 1.2
  }
};

const HIGHLIGHT_FILL_LAYER: LayerProps = {
  id: "review-highlight-fill",
  type: "fill",
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
  onSelectFeature
}: Props) {
  const mapRef = useRef<MapRef | null>(null);

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
    <div className="h-[640px] overflow-hidden rounded border">
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
          "review-openings",
          "review-details",
          "review-highlight-fill",
          "review-highlight-line"
        ]}
        mapStyle={STREET_MAP_STYLE}
        onClick={onMapClick}
      >
        <Source id="review-source" type="geojson" data={mapData}>
          <Layer {...POLYGON_FILL_LAYER} />
          <Layer {...POLYGON_LINE_LAYER} />
          <Layer {...OPENING_LAYER} />
          <Layer {...DETAIL_LAYER} />
        </Source>
        <Source id="review-selected-source" type="geojson" data={selectedData}>
          <Layer {...HIGHLIGHT_FILL_LAYER} />
          <Layer {...HIGHLIGHT_LINE_LAYER} />
        </Source>
        {overlayVisibility.errors !== false ? (
          <Source id="review-errors-source" type="geojson" data={errorData}>
            <Layer {...ERROR_OUTLINE_LAYER} />
          </Source>
        ) : null}
        {overlayVisibility.warnings !== false ? (
          <Source id="review-warnings-source" type="geojson" data={warningData}>
            <Layer {...WARNING_OUTLINE_LAYER} />
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
