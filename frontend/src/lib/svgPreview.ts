/**
 * Artwork-preview painting and floor partitioning.
 *
 * The preview is a decimated GeoJSON FeatureCollection in artwork points. It is
 * rendered to SVG for the assignment panel, and partitioned by the same
 * centroid-in-box rule the server applies at export. The partition here is
 * display-only: the server re-verifies membership from full-fidelity geometry.
 */

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

export type SvgPath = { d: string; fill: string | null; stroke: string | null; role: string };

export type PartitionFloor = {
  label: string;
  box: [number, number, number, number];
  layerNames: string[] | null;
};

type Preview = FeatureCollection;

function ringToPath(ring: Position[]): string {
  return "M" + ring.map((coord) => `${coord[0]},${coord[1]}`).join("L") + "Z";
}

export function geometryToPath(geometry: Geometry | null): string {
  if (!geometry) return "";
  switch (geometry.type) {
    case "Polygon":
      return geometry.coordinates.map(ringToPath).join("");
    case "MultiPolygon":
      return geometry.coordinates.map((poly) => poly.map(ringToPath).join("")).join("");
    case "LineString":
      return "M" + geometry.coordinates.map((coord) => `${coord[0]},${coord[1]}`).join("L");
    case "MultiLineString":
      return geometry.coordinates
        .map((line) => "M" + line.map((coord) => `${coord[0]},${coord[1]}`).join("L"))
        .join("");
    case "Point": {
      const [x, y] = geometry.coordinates;
      return `M${x},${y}l0.5,0.5L${x + 0.5},${y - 0.5}z`;
    }
    default:
      return "";
  }
}

export function buildSvgPaths(
  preview: Preview,
  bounds: [number, number, number, number]
): { viewBox: string; paths: SvgPath[] } {
  const [minx, miny, maxx, maxy] = bounds;
  return {
    viewBox: `${minx} ${miny} ${maxx - minx} ${maxy - miny}`,
    paths: preview.features.map((feature) => ({
      d: geometryToPath(feature.geometry),
      fill: (feature.properties?.fill_color as string | undefined) ?? null,
      stroke: (feature.properties?.stroke_color as string | undefined) ?? null,
      role: (feature.properties?.role as string | undefined) ?? "polygon"
    }))
  };
}

function collectVertices(geometry: Geometry, into: Position[]): void {
  switch (geometry.type) {
    case "Point":
      into.push(geometry.coordinates);
      break;
    case "MultiPoint":
      into.push(...geometry.coordinates);
      break;
    case "LineString":
      into.push(...geometry.coordinates);
      break;
    case "MultiLineString":
      for (const line of geometry.coordinates) into.push(...line);
      break;
    case "Polygon":
      for (const ring of geometry.coordinates) into.push(...ring);
      break;
    case "MultiPolygon":
      for (const poly of geometry.coordinates) for (const ring of poly) into.push(...ring);
      break;
    case "GeometryCollection":
      for (const child of geometry.geometries) collectVertices(child, into);
      break;
  }
}

/** Average vertex position — the same proxy the server-side rule uses. */
export function featureCentroid(feature: Feature): [number, number] {
  const vertices: Position[] = [];
  if (feature.geometry) collectVertices(feature.geometry, vertices);
  if (vertices.length === 0) return [0, 0];
  const x = vertices.reduce((sum, v) => sum + v[0], 0) / vertices.length;
  const y = vertices.reduce((sum, v) => sum + v[1], 0) / vertices.length;
  return [x, y];
}

export function partitionByFloors(
  preview: Preview,
  floors: PartitionFloor[]
): { perFloor: Map<string, Feature[]>; unassigned: Feature[] } {
  const perFloor = new Map<string, Feature[]>(floors.map((f) => [f.label, []]));
  const unassigned: Feature[] = [];

  for (const feature of preview.features) {
    const [cx, cy] = featureCentroid(feature);
    const layer = feature.properties?.ai_layer as string | undefined;
    const match = floors.find((floor) => {
      const [minx, miny, maxx, maxy] = floor.box;
      if (!(minx <= cx && cx <= maxx && miny <= cy && cy <= maxy)) return false;
      return floor.layerNames === null || floor.layerNames.includes(layer ?? "");
    });
    if (match) {
      perFloor.get(match.label)!.push(feature);
    } else {
      unassigned.push(feature);
    }
  }
  return { perFloor, unassigned };
}
