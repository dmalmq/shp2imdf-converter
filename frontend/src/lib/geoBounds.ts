/**
 * Bounding box of a feature list, scanned without materialising the positions.
 *
 * The map panels used to push one `[lon, lat]` array per position into a list
 * and then take a min/max over it. Measured against a real 18,750-feature
 * session (115,340 positions) that list retained 8.3 MB — 76 bytes per
 * position, where the two doubles it holds need 16 — and it was rebuilt on
 * every selection and visibility change, with up to three scans live at once.
 * Big datasets ran Chrome out of memory on that garbage alone, so the scan
 * folds straight into a running extent instead.
 */

/** `[[west, south], [east, north]]`, the shape MapLibre's `fitBounds` takes. */
export type LngLatBounds = [[number, number], [number, number]];

/** Anything with a GeoJSON geometry: review features and upload previews both fit. */
export type BoundsFeature = {
  geometry?: { coordinates?: unknown } | null;
};

type Extent = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  found: boolean;
};

/**
 * Folds every position under `value` into `extent`.
 *
 * A position is any array whose first two entries are finite numbers, so this
 * walks Point, LineString, Polygon and MultiPolygon nesting alike and ignores
 * the elevation a third entry may carry.
 */
function foldPositions(value: unknown, extent: Extent): void {
  if (!Array.isArray(value)) {
    return;
  }
  const lon = value[0];
  const lat = value[1];
  if (
    value.length >= 2 &&
    typeof lon === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lon) &&
    Number.isFinite(lat)
  ) {
    if (lon < extent.minLon) extent.minLon = lon;
    if (lon > extent.maxLon) extent.maxLon = lon;
    if (lat < extent.minLat) extent.minLat = lat;
    if (lat > extent.maxLat) extent.maxLat = lat;
    extent.found = true;
    return;
  }
  // An indexed loop, not `forEach`: this runs once per array in the dataset and
  // a callback per array is the other allocation this function exists to avoid.
  for (let index = 0; index < value.length; index += 1) {
    foldPositions(value[index], extent);
  }
}

/** Bounds covering every positioned feature, or null when none of them has one. */
export function computeGeoBounds(features: readonly BoundsFeature[]): LngLatBounds | null {
  const extent: Extent = {
    minLon: Infinity,
    minLat: Infinity,
    maxLon: -Infinity,
    maxLat: -Infinity,
    found: false
  };
  for (let index = 0; index < features.length; index += 1) {
    const geometry = features[index].geometry;
    if (!geometry) {
      continue;
    }
    foldPositions(geometry.coordinates, extent);
  }
  if (!extent.found) {
    return null;
  }
  return [
    [extent.minLon, extent.minLat],
    [extent.maxLon, extent.maxLat]
  ];
}
