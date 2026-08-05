/**
 * Artwork-preview painting and floor partitioning.
 *
 * The preview is a decimated GeoJSON FeatureCollection in artwork points. It is
 * rendered to SVG for the assignment panel, and partitioned by the same
 * page/layer/centroid-in-box rule the server applies at export. The partition
 * here is display-only: the server re-verifies membership from full-fidelity
 * geometry.
 */

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

export type SvgPath = { d: string; fill: string | null; stroke: string | null; role: string };

export type PartitionFloor = {
  label: string;
  /** Artwork-space box, or null for no spatial restriction. */
  box: [number, number, number, number] | null;
  /** 1-based page numbers, or null for no page restriction. */
  pages: number[] | null;
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

/**
 * Split a preview into one FeatureCollection per page, keyed by page number.
 *
 * Pages are normalized to their own MediaBox origin by the importer, so every
 * page's geometry overlaps in artwork space and only this split separates them.
 */
export function splitByPage(preview: Preview): Map<number, FeatureCollection> {
  const buckets = new Map<number, Feature[]>();
  for (const feature of preview.features) {
    const page = Number(feature.properties?.page ?? 1);
    const bucket = buckets.get(page);
    if (bucket) bucket.push(feature);
    else buckets.set(page, [feature]);
  }
  return new Map(
    [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, features]) => [
        page,
        { type: "FeatureCollection", features } as FeatureCollection
      ])
  );
}

export type SvgClientRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Map a client (viewport) position to artwork coordinates.
 *
 * The artwork SVG renders with the default `preserveAspectRatio="xMidYMid meet"`,
 * so the artwork is letterboxed inside the element; and artwork coordinates are
 * PDF points (y-up, bottom-left origin) while SVG user space is y-down, so the
 * content is flipped vertically. This inverts both effects so a box drawn with
 * the pointer lands on the artwork where the user sees it.
 */
export function clientToArtworkPoint(
  bounds: [number, number, number, number],
  rect: SvgClientRect,
  clientX: number,
  clientY: number
): [number, number] {
  const [minx, miny, maxx, maxy] = bounds;
  const viewW = maxx - minx;
  const viewH = maxy - miny;
  if (!(viewW > 0) || !(viewH > 0) || !(rect.width > 0) || !(rect.height > 0)) {
    return [(minx + maxx) / 2, (miny + maxy) / 2];
  }
  const scale = Math.min(rect.width / viewW, rect.height / viewH);
  const contentW = viewW * scale;
  const contentH = viewH * scale;
  const offsetX = rect.left + (rect.width - contentW) / 2;
  const offsetY = rect.top + (rect.height - contentH) / 2;
  const x = minx + (clientX - offsetX) / scale;
  const y = maxy - (clientY - offsetY) / scale; // y-flip: screen top is artwork maxy
  return [x, y];
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
    const page = Number(feature.properties?.page ?? 1);
    // Same conjunction as the server's _floor_mask, in the same order:
    // each filter is optional and null means "no restriction".
    const match = floors.find((floor) => {
      if (floor.pages !== null && !floor.pages.includes(page)) return false;
      if (floor.layerNames !== null && !floor.layerNames.includes(layer ?? "")) return false;
      if (floor.box !== null) {
        const [minx, miny, maxx, maxy] = floor.box;
        if (!(minx <= cx && cx <= maxx && miny <= cy && cy <= maxy)) return false;
      }
      return true;
    });
    if (match) {
      perFloor.get(match.label)!.push(feature);
    } else {
      unassigned.push(feature);
    }
  }
  return { perFloor, unassigned };
}
