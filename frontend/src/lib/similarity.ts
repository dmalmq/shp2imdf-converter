/**
 * Similarity transform for placing Illustrator artwork on the map.
 *
 * Artwork coordinates are PDF points, y-up from a bottom-left origin, which
 * already matches GIS axis convention — there is no flip anywhere here.
 *
 * Preview maths runs in a local ENU tangent frame anchored at `mapAnchor`,
 * using the WGS84 radii of curvature. Web Mercator is deliberately NOT used:
 * it is not conformal on the ellipsoid (north and east scales differ by about
 * 0.45% at Tokyo), so a similarity in Mercator metres is not a similarity on
 * the ground. Measured against the authoritative backend export on a 59 m
 * artwork, Mercator lands 23 cm out; this ENU frame lands 0.58 cm out.
 *
 * `rotationDeg` is measured CCW from TRUE north, which is also ENU +north, so
 * no convergence correction belongs here. The backend applies the convergence
 * when it converts to its projected grid.
 */

import type { Geometry, Position } from "geojson";

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

export type SimilarityTransform = {
  artworkAnchor: [number, number];
  mapAnchor: [number, number];
  rotationDeg: number;
  metresPerPoint: number;
  workingCrs: string;
};

export type AffineMatrix = [number, number, number, number, number, number];

export class SimilarityError extends Error {}

/** Ground metres per PDF point for a 1:denominator drawing. */
export function metresPerPointForScale(denominator: number): number {
  if (!(denominator > 0)) {
    throw new SimilarityError("Drawing scale denominator must be positive.");
  }
  return ((MM_PER_INCH / POINTS_PER_INCH) * denominator) / 1000;
}

/** Meridian radius of curvature, metres per radian of latitude. */
export function meridianRadius(latitude: number): number {
  const w = 1 - WGS84_E2 * Math.sin((latitude * Math.PI) / 180) ** 2;
  return (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5);
}

/** Prime-vertical radius of curvature. */
export function primeVerticalRadius(latitude: number): number {
  const w = 1 - WGS84_E2 * Math.sin((latitude * Math.PI) / 180) ** 2;
  return WGS84_A / Math.sqrt(w);
}

/** Local ENU metres about an anchor to lon/lat. */
export function enuToLngLat(
  east: number,
  north: number,
  anchorLon: number,
  anchorLat: number
): [number, number] {
  const lat = anchorLat + (north / meridianRadius(anchorLat)) * (180 / Math.PI);
  const lon =
    anchorLon +
    (east / (primeVerticalRadius(anchorLat) * Math.cos((anchorLat * Math.PI) / 180))) *
      (180 / Math.PI);
  return [lon, lat];
}

/** Inverse of {@link enuToLngLat}. */
export function lngLatToEnu(
  lon: number,
  lat: number,
  anchorLon: number,
  anchorLat: number
): [number, number] {
  const north =
    ((lat - anchorLat) * Math.PI) / 180 * meridianRadius(anchorLat);
  const east =
    ((lon - anchorLon) * Math.PI) / 180 *
    primeVerticalRadius(anchorLat) *
    Math.cos((anchorLat * Math.PI) / 180);
  return [east, north];
}

/** Affine mapping artwork points into ENU metres about `mapAnchor`. */
export function toEnuMatrix(transform: SimilarityTransform): AffineMatrix {
  if (!(transform.metresPerPoint > 0)) {
    throw new SimilarityError("metresPerPoint must be positive.");
  }
  const theta = (transform.rotationDeg * Math.PI) / 180;
  const scale = transform.metresPerPoint;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const a = scale * cos;
  const b = -scale * sin;
  const d = scale * sin;
  const e = scale * cos;
  const [x0, y0] = transform.artworkAnchor;
  return [a, b, d, e, -(a * x0 + b * y0), -(d * x0 + e * y0)];
}

export function applyMatrix(matrix: AffineMatrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[1] * y + matrix[4], matrix[2] * x + matrix[3] * y + matrix[5]];
}

type GeoJsonFeature = { type: "Feature"; geometry: Geometry | null; properties: unknown };
type GeoJsonCollection = { type: "FeatureCollection"; features: GeoJsonFeature[] };

/** Place an artwork-space FeatureCollection onto the map as lon/lat. */
export function transformGeoJson(
  collection: GeoJsonCollection,
  transform: SimilarityTransform
): GeoJsonCollection {
  const matrix = toEnuMatrix(transform);
  const [anchorLon, anchorLat] = transform.mapAnchor;
  const movePosition = (position: Position): Position => {
    const [east, north] = applyMatrix(matrix, position[0], position[1]);
    return enuToLngLat(east, north, anchorLon, anchorLat);
  };
  // Switch per geometry type rather than walking `coordinates` blindly: a
  // GeometryCollection carries `geometries` instead, and reading its absent
  // `coordinates` throws on undefined[0], taking the whole placement map down.
  const moveGeometry = (geometry: Geometry): Geometry => {
    switch (geometry.type) {
      case "GeometryCollection":
        return { ...geometry, geometries: geometry.geometries.map(moveGeometry) };
      case "Point":
        return { ...geometry, coordinates: movePosition(geometry.coordinates) };
      case "MultiPoint":
        return { ...geometry, coordinates: geometry.coordinates.map(movePosition) };
      case "LineString":
        return { ...geometry, coordinates: geometry.coordinates.map(movePosition) };
      case "MultiLineString":
        return { ...geometry, coordinates: geometry.coordinates.map((l) => l.map(movePosition)) };
      case "Polygon":
        return { ...geometry, coordinates: geometry.coordinates.map((r) => r.map(movePosition)) };
      case "MultiPolygon":
        return {
          ...geometry,
          coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(movePosition)))
        };
    }
  };
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: feature.geometry ? moveGeometry(feature.geometry) : feature.geometry
    }))
  };
}

/** One artwork point placed on the map. */
export function artworkToLngLat(
  transform: SimilarityTransform,
  x: number,
  y: number
): [number, number] {
  const [east, north] = applyMatrix(toEnuMatrix(transform), x, y);
  return enuToLngLat(east, north, transform.mapAnchor[0], transform.mapAnchor[1]);
}

export type GizmoCorner = {
  /** Artwork-space corner, named as it appears before any rotation. */
  key: "sw" | "se" | "ne" | "nw";
  artwork: [number, number];
  lngLat: [number, number];
  cursor: string;
};

export type GizmoFrame = {
  /** Closed outline of the artwork bounds, rotated onto the map. */
  ring: [number, number][];
  corners: GizmoCorner[];
  /** Handle on a stem past the artwork's top edge. */
  rotate: { artwork: [number, number]; lngLat: [number, number] };
};

/** Length of the rotation stem as a share of artwork height. */
const ROTATE_STEM = 0.12;

/**
 * On-map geometry of the transform gizmo: the artwork's bounding box, its four
 * scale corners and the rotation handle, all placed through `transform`.
 *
 * Everything is derived in artwork space first, so the gizmo rotates and scales
 * with the artwork instead of being an unrelated screen-space overlay.
 */
export function gizmoFrame(
  transform: SimilarityTransform,
  bounds: [number, number, number, number]
): GizmoFrame {
  const [minX, minY, maxX, maxY] = bounds;
  const place = (x: number, y: number) => artworkToLngLat(transform, x, y);
  const cornerSpecs: { key: GizmoCorner["key"]; artwork: [number, number]; cursor: string }[] = [
    { key: "sw", artwork: [minX, minY], cursor: "nesw-resize" },
    { key: "se", artwork: [maxX, minY], cursor: "nwse-resize" },
    { key: "ne", artwork: [maxX, maxY], cursor: "nesw-resize" },
    { key: "nw", artwork: [minX, maxY], cursor: "nwse-resize" }
  ];
  const corners: GizmoCorner[] = cornerSpecs.map((corner) => ({
    ...corner,
    lngLat: place(corner.artwork[0], corner.artwork[1])
  }));
  const rotateArtwork: [number, number] = [
    (minX + maxX) / 2,
    maxY + Math.max(maxY - minY, 1) * ROTATE_STEM
  ];
  return {
    ring: [
      place(minX, minY),
      place(maxX, minY),
      place(maxX, maxY),
      place(minX, maxY),
      place(minX, minY)
    ],
    corners,
    rotate: { artwork: rotateArtwork, lngLat: place(rotateArtwork[0], rotateArtwork[1]) }
  };
}

/**
 * Rotation that points `artworkHandle` at a map bearing.
 *
 * `toEnuMatrix` maps artwork (dx,dy) to a bearing of `angleOf(dx,dy) - rotation`
 * (rotation is CCW from true north), so aiming the handle at `bearingDeg` means
 * rotation = handleAngle - bearing. Without this the handle would mirror the
 * pointer instead of following it.
 */
export function rotationForHandle(
  artworkHandle: [number, number],
  artworkAnchor: [number, number],
  bearingDeg: number
): number {
  const dx = artworkHandle[0] - artworkAnchor[0];
  const dy = artworkHandle[1] - artworkAnchor[1];
  if (dx === 0 && dy === 0) {
    throw new SimilarityError("The rotation handle must not sit on the anchor.");
  }
  const handleAngle = (Math.atan2(dx, dy) * 180) / Math.PI;
  const rotation = handleAngle - bearingDeg;
  return ((rotation + 540) % 360) - 180;
}

/**
 * Least-squares similarity fit. `enuPoints` are ENU metres about the current
 * anchor; convert map clicks with {@link lngLatToEnu} first.
 *
 * Two pairs are the minimum. The "one control point plus the existing anchor"
 * case is handled by the caller supplying the anchor as the second pair.
 */
export function fitHelmert(
  artworkPoints: [number, number][],
  enuPoints: [number, number][],
  workingCrs: string,
  fixedMetresPerPoint?: number
): SimilarityTransform {
  if (artworkPoints.length !== enuPoints.length) {
    throw new SimilarityError("Each control point needs both an artwork and a map position.");
  }
  if (artworkPoints.length < 2) {
    throw new SimilarityError("At least two control points are required.");
  }

  const n = artworkPoints.length;
  const pBar: [number, number] = [
    artworkPoints.reduce((sum, p) => sum + p[0], 0) / n,
    artworkPoints.reduce((sum, p) => sum + p[1], 0) / n
  ];
  const qBar: [number, number] = [
    enuPoints.reduce((sum, p) => sum + p[0], 0) / n,
    enuPoints.reduce((sum, p) => sum + p[1], 0) / n
  ];

  let denominator = 0;
  let real = 0;
  let imag = 0;
  for (let i = 0; i < n; i += 1) {
    const px = artworkPoints[i][0] - pBar[0];
    const py = artworkPoints[i][1] - pBar[1];
    const qx = enuPoints[i][0] - qBar[0];
    const qy = enuPoints[i][1] - qBar[1];
    denominator += px * px + py * py;
    real += qx * px + qy * py;
    imag += qy * px - qx * py;
  }
  if (denominator <= 0) {
    throw new SimilarityError("Control points in the artwork must not all be the same point.");
  }
  if (real === 0 && imag === 0) {
    throw new SimilarityError("Control points on the map must not all be the same point.");
  }

  const rotation = (Math.atan2(imag, real) * 180) / Math.PI;
  return {
    artworkAnchor: pBar,
    mapAnchor: [qBar[0], qBar[1]],
    rotationDeg: ((rotation + 180) % 360) - 180,
    metresPerPoint: fixedMetresPerPoint ?? Math.hypot(real, imag) / denominator,
    workingCrs
  };
}

/** Per-point misfit in metres and their RMSE. */
export function residuals(
  transform: SimilarityTransform,
  artworkPoints: [number, number][],
  enuPoints: [number, number][]
): { perPoint: number[]; rmse: number } {
  const matrix = toEnuMatrix(transform);
  const perPoint = artworkPoints.map((point, index) => {
    const [east, north] = applyMatrix(matrix, point[0], point[1]);
    return Math.hypot(east - enuPoints[index][0], north - enuPoints[index][1]);
  });
  const rmse = Math.sqrt(perPoint.reduce((sum, d) => sum + d * d, 0) / perPoint.length);
  return { perPoint, rmse };
}
