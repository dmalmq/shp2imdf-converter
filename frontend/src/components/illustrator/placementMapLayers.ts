import type { FeatureCollection } from "geojson";

/**
 * MapLibre source and layer ids for the placement map.
 *
 * These must never change when a floor becomes active/ghost or a reference
 * shapefile is hidden. react-map-gl unmounts <Source> by React key, and if the
 * MapLibre id is reused in the same tick the library addSource/addLayer-s on
 * top of a source that is about to be removed — the WebGL canvas goes white.
 */

export const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: "FeatureCollection",
  features: []
};

/** Empty fill that sits above the basemap; reference layers insert before it. */
export const ARTWORK_SLOT_LAYER_ID = "placement-artwork-start";
export const ARTWORK_SLOT_SOURCE_ID = "placement-artwork-slot";

/** Empty fill that sits above every floor; handles and control points sit after it. */
export const OVERLAY_SLOT_LAYER_ID = "placement-overlay-end";
export const OVERLAY_SLOT_SOURCE_ID = "placement-overlay-slot";

export function floorSourceId(label: string): string {
  return `floor-${label}`;
}

export function floorFillLayerId(label: string): string {
  return `floor-${label}-fill`;
}

export function floorLineLayerId(label: string): string {
  return `floor-${label}-line`;
}

export function referenceSourceId(name: string): string {
  return `reference-${name}`;
}

export function referenceFillLayerId(name: string): string {
  return `reference-${name}-fill`;
}

export function referenceLineLayerId(name: string): string {
  return `reference-${name}-line`;
}

export function referencePointLayerId(name: string): string {
  return `reference-${name}-point`;
}

export function layerVisibility(visible: boolean): "visible" | "none" {
  return visible ? "visible" : "none";
}
