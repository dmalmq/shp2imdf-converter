import type { Feature, FeatureCollection, Geometry } from "geojson";

import {
  buildSvgPaths,
  clientToArtworkPoint,
  featureCentroid,
  geometryToPath,
  partitionByFloors,
  splitByPage
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
    { label: "1F", box: [0, 0, 20, 20] as [number, number, number, number], pages: null, layerNames: null },
    { label: "2F", box: [20, 0, 40, 20] as [number, number, number, number], pages: null, layerNames: ["柱"] }
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
    { label: "2F", box: [20, 0, 40, 20] as [number, number, number, number], pages: null, layerNames: ["柱"] }
  ];
  const { perFloor, unassigned } = partitionByFloors(preview, floors);
  expect(perFloor.get("2F")).toHaveLength(1);
  expect(unassigned).toHaveLength(1);
});

const SQUARE = [0, 0, 10, 10] as [number, number, number, number];

test("clientToArtworkPoint flips y: screen top maps to artwork maxy", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  // Top of the element -> artwork maxy; bottom -> miny.
  expect(clientToArtworkPoint(SQUARE, rect, 50, 0)[1]).toBeCloseTo(10, 6);
  expect(clientToArtworkPoint(SQUARE, rect, 50, 100)[1]).toBeCloseTo(0, 6);
  // x is not flipped.
  expect(clientToArtworkPoint(SQUARE, rect, 0, 50)[0]).toBeCloseTo(0, 6);
  expect(clientToArtworkPoint(SQUARE, rect, 100, 50)[0]).toBeCloseTo(10, 6);
});

test("clientToArtworkPoint accounts for xMidYMid meet letterboxing", () => {
  // 10x10 artwork in a 200x100 element: content is 100x100, centered at x 50..150.
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  expect(clientToArtworkPoint(SQUARE, rect, 50, 50)[0]).toBeCloseTo(0, 6); // content left edge
  expect(clientToArtworkPoint(SQUARE, rect, 150, 50)[0]).toBeCloseTo(10, 6); // content right edge
  expect(clientToArtworkPoint(SQUARE, rect, 50, 0)[1]).toBeCloseTo(10, 6); // content top edge
});

test("clientToArtworkPoint is offset by the element position", () => {
  const rect = { left: 386, top: 182, width: 628, height: 256 };
  // Reproduction of the orientation fixture: 180x180 artwork in a 628x256 box.
  const bounds = [10, 10, 190, 190] as [number, number, number, number];
  const scale = Math.min(628 / 180, 256 / 180);
  const offsetX = 386 + (628 - 180 * scale) / 2;
  const offsetY = 182 + (256 - 180 * scale) / 2;
  const [x, y] = clientToArtworkPoint(bounds, rect, offsetX, offsetY);
  expect(x).toBeCloseTo(10, 6);
  expect(y).toBeCloseTo(190, 6); // content top-left is artwork maxx/maxy
});

test("clientToArtworkPoint degrades to the artwork centre on a zero-size viewport", () => {
  const rect = { left: 0, top: 0, width: 0, height: 0 };
  const [x, y] = clientToArtworkPoint(SQUARE, rect, 0, 0);
  expect(x).toBeCloseTo(5, 6);
  expect(y).toBeCloseTo(5, 6);
});

function pageFeature(page: number, x: number, y: number, layer = "Fill Layer") {
  return {
    type: "Feature" as const,
    properties: { page, ai_layer: layer, role: "polygon" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [x, y],
          [x + 10, y],
          [x + 10, y + 10],
          [x, y + 10],
          [x, y]
        ]
      ]
    }
  };
}

function threePagePreview() {
  return {
    type: "FeatureCollection" as const,
    features: [pageFeature(1, 0, 0), pageFeature(2, 0, 0), pageFeature(3, 50, 50)]
  };
}

test("splitByPage groups features by page in ascending order", () => {
  const byPage = splitByPage(threePagePreview());
  expect([...byPage.keys()]).toEqual([1, 2, 3]);
  expect(byPage.get(1)!.features).toHaveLength(1);
  expect(byPage.get(1)!.type).toBe("FeatureCollection");
});

test("splitByPage treats a feature with no page property as page 1", () => {
  const preview = {
    type: "FeatureCollection" as const,
    features: [{ ...pageFeature(1, 0, 0), properties: { ai_layer: "Fill Layer" } }]
  };
  expect([...splitByPage(preview).keys()]).toEqual([1]);
});

test("partitionByFloors assigns by page when no box is given", () => {
  const { perFloor, unassigned } = partitionByFloors(threePagePreview(), [
    { label: "1F", box: null, pages: [1], layerNames: null }
  ]);
  expect(perFloor.get("1F")).toHaveLength(1);
  expect(unassigned).toHaveLength(2);
});

test("partitionByFloors merges several pages under one label", () => {
  const { perFloor, unassigned } = partitionByFloors(threePagePreview(), [
    { label: "1F", box: null, pages: [1, 3], layerNames: null }
  ]);
  expect(perFloor.get("1F")).toHaveLength(2);
  expect(unassigned).toHaveLength(1);
});

test("partitionByFloors intersects page with box", () => {
  const floors = [
    { label: "1F", box: [40, 40, 80, 80] as [number, number, number, number], pages: [3], layerNames: null }
  ];
  expect(partitionByFloors(threePagePreview(), floors).perFloor.get("1F")).toHaveLength(1);

  const wrongPage = [{ ...floors[0], pages: [1] }];
  expect(partitionByFloors(threePagePreview(), wrongPage).perFloor.get("1F")).toHaveLength(0);
});

test("partitionByFloors intersects page with layer restriction", () => {
  const preview = {
    type: "FeatureCollection" as const,
    features: [pageFeature(1, 0, 0, "walls"), pageFeature(1, 0, 0, "tracks")]
  };
  const { perFloor } = partitionByFloors(preview, [
    { label: "1F", box: null, pages: [1], layerNames: ["walls"] }
  ]);
  expect(perFloor.get("1F")).toHaveLength(1);
});

test("a floor with no page, box or layer restriction claims everything", () => {
  const { perFloor, unassigned } = partitionByFloors(threePagePreview(), [
    { label: "artwork", box: null, pages: null, layerNames: null }
  ]);
  expect(perFloor.get("artwork")).toHaveLength(3);
  expect(unassigned).toHaveLength(0);
});
