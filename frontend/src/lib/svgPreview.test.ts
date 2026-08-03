import type { Feature, FeatureCollection, Geometry } from "geojson";

import {
  buildSvgPaths,
  featureCentroid,
  geometryToPath,
  partitionByFloors
} from "./svgPreview";

const POLYGON: Geometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10]
    ]
  ]
};
const LINE: Geometry = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [5, 5]
  ]
};
const MULTI: Geometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0]
      ]
    ],
    [
      [
        [4, 0],
        [6, 0],
        [6, 2],
        [4, 2],
        [4, 0]
      ]
    ]
  ]
};

function feature(geometry: Geometry, properties: Record<string, unknown>): Feature {
  return { type: "Feature", properties, geometry } satisfies Feature;
}

test("a polygon becomes a closed M/L/Z path", () => {
  const d = geometryToPath(POLYGON);
  expect(d.startsWith("M0,0")).toBe(true);
  expect(d.endsWith("Z")).toBe(true);
  expect(d).toContain("L10,0");
});

test("a line is an open path", () => {
  const d = geometryToPath(LINE);
  expect(d.endsWith("Z")).toBe(false);
  expect(d).toContain("L5,5");
});

test("a multipolygon emits one subpath per part", () => {
  const d = geometryToPath(MULTI);
  expect(d.match(/M/g)).toHaveLength(2);
});

test("buildSvgPaths produces a viewBox and one path per feature", () => {
  const preview: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature(POLYGON, { role: "polygon", fill_color: "#ff0000" }),
      feature(LINE, { role: "line", stroke_color: "#0000ff" })
    ]
  };
  const { viewBox, paths } = buildSvgPaths(preview, [0, 0, 10, 10]);
  expect(viewBox).toBe("0 0 10 10");
  expect(paths).toHaveLength(2);
  expect(paths[0].fill).toBe("#ff0000");
  expect(paths[1].stroke).toBe("#0000ff");
});

test("featureCentroid averages the coordinates", () => {
  const centroid = featureCentroid(feature(POLYGON, {}));
  expect(centroid[0]).toBeCloseTo(5, 6);
  expect(centroid[1]).toBeCloseTo(5, 6);
});

test("partitionByFloors assigns by centroid and layer restriction", () => {
  const preview: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature(POLYGON, { ai_layer: "壁" }),
      feature({ type: "Point", coordinates: [25, 5] }, { ai_layer: "柱" }),
      feature({ type: "Point", coordinates: [100, 100] }, { ai_layer: "柱" })
    ]
  };
  const floors = [
    { label: "1F", box: [0, 0, 20, 20] as [number, number, number, number], layerNames: null },
    { label: "2F", box: [20, 0, 40, 20] as [number, number, number, number], layerNames: ["柱"] }
  ];
  const { perFloor, unassigned } = partitionByFloors(preview, floors);
  expect(perFloor.get("1F")).toHaveLength(1);
  expect(perFloor.get("2F")).toHaveLength(1);
  expect(unassigned).toHaveLength(1);
});

test("layer restriction excludes matching-position features on other layers", () => {
  const preview: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Point", coordinates: [30, 5] }, { ai_layer: "壁" }),
      feature({ type: "Point", coordinates: [30, 5] }, { ai_layer: "柱" })
    ]
  };
  const floors = [
    { label: "2F", box: [20, 0, 40, 20] as [number, number, number, number], layerNames: ["柱"] }
  ];
  const { perFloor, unassigned } = partitionByFloors(preview, floors);
  expect(perFloor.get("2F")).toHaveLength(1);
  expect(unassigned).toHaveLength(1);
});
