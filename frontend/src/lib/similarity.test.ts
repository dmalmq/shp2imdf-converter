import {
  applyMatrix,
  artworkToLngLat,
  enuToLngLat,
  fitHelmert,
  gizmoFrame,
  lngLatToEnu,
  metresPerPointForScale,
  residuals,
  rotationForHandle,
  toEnuMatrix,
  transformGeoJson,
  type SimilarityTransform
} from "./similarity";

// Golden fixture. GOLDEN_LNGLAT is asserted identically in
// backend/tests/test_illustrator_georeference.py.
const GOLDEN_ARTWORK: [number, number][] = [
  [100, 200],
  [400, 200],
  [400, 350],
  [100, 350]
];
const GOLDEN_LNGLAT: [number, number][] = [
  [139.700258, 35.690921],
  [139.70076435, 35.691159486],
  [139.70061818, 35.691366023],
  [139.700111829, 35.691127536]
];
const GOLDEN: SimilarityTransform = {
  artworkAnchor: [100, 200],
  mapAnchor: [139.700258, 35.690921],
  rotationDeg: 30,
  metresPerPoint: 0.176389,
  workingCrs: "EPSG:6677"
};

// 6 decimal degrees is about 5.5 cm. The correct implementation lands 0.58 cm
// from the backend; the two bugs this guards against land 8 cm (grid-north
// rotation) and 23 cm (Web Mercator), so both fail this tolerance.
const DEGREE_PRECISION = 6;

test("drawing scale converts to metres per point exactly", () => {
  expect(metresPerPointForScale(500)).toBeCloseTo(0.1763888888, 9);
  expect(metresPerPointForScale(1)).toBeCloseTo(0.0003527777, 9);
});

test("a non-positive drawing scale is rejected", () => {
  expect(() => metresPerPointForScale(0)).toThrow();
});

test("the golden fixture matches the backend constants", () => {
  const matrix = toEnuMatrix(GOLDEN);
  GOLDEN_ARTWORK.forEach((point, index) => {
    const [east, north] = applyMatrix(matrix, point[0], point[1]);
    const [lon, lat] = enuToLngLat(east, north, GOLDEN.mapAnchor[0], GOLDEN.mapAnchor[1]);
    expect(lon).toBeCloseTo(GOLDEN_LNGLAT[index][0], DEGREE_PRECISION);
    expect(lat).toBeCloseTo(GOLDEN_LNGLAT[index][1], DEGREE_PRECISION);
  });
});

test("the artwork anchor lands exactly on the map anchor", () => {
  const matrix = toEnuMatrix(GOLDEN);
  const [east, north] = applyMatrix(matrix, GOLDEN.artworkAnchor[0], GOLDEN.artworkAnchor[1]);
  expect(east).toBeCloseTo(0, 9);
  expect(north).toBeCloseTo(0, 9);
});

test("zero rotation points artwork +y at true north", () => {
  const matrix = toEnuMatrix({ ...GOLDEN, rotationDeg: 0 });
  const [east, north] = applyMatrix(matrix, 100, 350);
  expect(east).toBeCloseTo(0, 9);
  expect(north).toBeGreaterThan(0);
});

test("a 300 pt edge becomes 300 * scale metres", () => {
  const matrix = toEnuMatrix(GOLDEN);
  const a = applyMatrix(matrix, 100, 200);
  const b = applyMatrix(matrix, 400, 200);
  expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(300 * GOLDEN.metresPerPoint, 9);
});

test("scale is uniform, so a square stays square", () => {
  const matrix = toEnuMatrix(GOLDEN);
  const origin = applyMatrix(matrix, 0, 0);
  const alongX = applyMatrix(matrix, 100, 0);
  const alongY = applyMatrix(matrix, 0, 100);
  expect(Math.hypot(alongX[0] - origin[0], alongX[1] - origin[1])).toBeCloseTo(
    Math.hypot(alongY[0] - origin[0], alongY[1] - origin[1]),
    9
  );
});

test("rotation is recoverable from the matrix", () => {
  const [a, , d] = toEnuMatrix(GOLDEN);
  expect((Math.atan2(d, a) * 180) / Math.PI).toBeCloseTo(GOLDEN.rotationDeg, 9);
});

test("ENU and lon/lat round-trip", () => {
  const [east, north] = lngLatToEnu(139.7015, 35.6915, GOLDEN.mapAnchor[0], GOLDEN.mapAnchor[1]);
  const [lon, lat] = enuToLngLat(east, north, GOLDEN.mapAnchor[0], GOLDEN.mapAnchor[1]);
  expect(lon).toBeCloseTo(139.7015, 9);
  expect(lat).toBeCloseTo(35.6915, 9);
});

test("transformGeoJson places a polygon on the golden constants", () => {
  const collection = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature",
        properties: { ai_layer: "floor" },
        geometry: { type: "Polygon", coordinates: [GOLDEN_ARTWORK] }
      }
    ]
  };
  const placed = transformGeoJson(collection, GOLDEN);
  const ring = placed.features[0].geometry.coordinates[0] as [number, number][];
  ring.forEach(([lon, lat], index) => {
    expect(lon).toBeCloseTo(GOLDEN_LNGLAT[index][0], DEGREE_PRECISION);
    expect(lat).toBeCloseTo(GOLDEN_LNGLAT[index][1], DEGREE_PRECISION);
  });
  expect(placed.features[0].properties.ai_layer).toBe("floor");
});

test("Helmert recovers a known rotation and scale", () => {
  const truth: SimilarityTransform = {
    ...GOLDEN,
    artworkAnchor: [0, 0],
    rotationDeg: 42.5,
    metresPerPoint: 0.25
  };
  const artwork: [number, number][] = [
    [0, 0],
    [500, 0],
    [500, 300]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));
  const fitted = fitHelmert(artwork, mapped, "EPSG:6677");
  expect(fitted.rotationDeg).toBeCloseTo(42.5, 6);
  expect(fitted.metresPerPoint).toBeCloseTo(0.25, 9);
});

test("Helmert with a locked scale keeps that scale", () => {
  const truth: SimilarityTransform = { ...GOLDEN, artworkAnchor: [0, 0], rotationDeg: -17.25 };
  const artwork: [number, number][] = [
    [0, 0],
    [400, 120]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));
  const fitted = fitHelmert(artwork, mapped, "EPSG:6677", GOLDEN.metresPerPoint);
  expect(fitted.metresPerPoint).toBe(GOLDEN.metresPerPoint);
  expect(fitted.rotationDeg).toBeCloseTo(-17.25, 6);
});

test("Helmert normalises rotation into (-180, 180]", () => {
  const truth: SimilarityTransform = { ...GOLDEN, artworkAnchor: [0, 0], rotationDeg: 200 };
  const artwork: [number, number][] = [
    [0, 0],
    [500, 0]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));
  expect(fitHelmert(artwork, mapped, "EPSG:6677").rotationDeg).toBeCloseTo(-160, 6);
});

test("Helmert refuses fewer than two pairs", () => {
  expect(() => fitHelmert([[0, 0]], [[0, 0]], "EPSG:6677")).toThrow();
});

test("Helmert refuses mismatched pair counts", () => {
  expect(() =>
    fitHelmert(
      [
        [0, 0],
        [1, 1]
      ],
      [[0, 0]],
      "EPSG:6677"
    )
  ).toThrow();
});

test("Helmert refuses coincident artwork points", () => {
  expect(() =>
    fitHelmert(
      [
        [5, 5],
        [5, 5]
      ],
      [
        [0, 0],
        [10, 0]
      ],
      "EPSG:6677"
    )
  ).toThrow();
});

test("residuals are zero for an exact fit and large for a bad point", () => {
  const truth: SimilarityTransform = { ...GOLDEN, artworkAnchor: [0, 0] };
  const artwork: [number, number][] = [
    [0, 0],
    [500, 0],
    [500, 300]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));

  expect(residuals(truth, artwork, mapped).rmse).toBeCloseTo(0, 6);

  const broken: [number, number][] = [...mapped];
  broken[2] = [broken[2][0] + 90, broken[2][1]];
  const bad = residuals(truth, artwork, broken);
  expect(bad.rmse).toBeGreaterThan(1);
  expect(Math.max(...bad.perPoint)).toBeGreaterThan(1);
});

const UNROTATED: SimilarityTransform = {
  artworkAnchor: [50, 50],
  mapAnchor: [139.7671, 35.6812],
  rotationDeg: 0,
  metresPerPoint: 0.352778,
  workingCrs: "EPSG:6677"
};
const BOX: [number, number, number, number] = [0, 0, 100, 100];

/** Bearing of an artwork point about the anchor, CCW-from-north degrees. */
function bearingOf(transform: SimilarityTransform, point: [number, number]): number {
  const [lng, lat] = artworkToLngLat(transform, point[0], point[1]);
  const [east, north] = lngLatToEnu(lng, lat, transform.mapAnchor[0], transform.mapAnchor[1]);
  return (Math.atan2(east, north) * 180) / Math.PI;
}

test("the gizmo outline closes on the artwork bounds", () => {
  const frame = gizmoFrame(UNROTATED, BOX);
  expect(frame.ring).toHaveLength(5);
  expect(frame.ring[0]).toEqual(frame.ring[4]);
  expect(frame.corners.map((corner) => corner.key)).toEqual(["sw", "se", "ne", "nw"]);
});

test("unrotated artwork puts its corners at the expected compass positions", () => {
  const frame = gizmoFrame(UNROTATED, BOX);
  const at = (key: string) => frame.corners.find((corner) => corner.key === key)!.lngLat;
  // y-up artwork: "ne" is further north and east than "sw".
  expect(at("ne")[0]).toBeGreaterThan(at("sw")[0]);
  expect(at("ne")[1]).toBeGreaterThan(at("sw")[1]);
  // The rotation handle sits beyond the top edge.
  expect(frame.rotate.lngLat[1]).toBeGreaterThan(at("ne")[1]);
});

test("the rotation handle follows the pointer instead of mirroring it", () => {
  // Aiming the handle east must rotate the frame so the handle really lands east.
  const frame = gizmoFrame(UNROTATED, BOX);
  for (const target of [0, 45, 90, -90, 150, -179]) {
    const rotationDeg = rotationForHandle(frame.rotate.artwork, UNROTATED.artworkAnchor, target);
    const rotated: SimilarityTransform = { ...UNROTATED, rotationDeg };
    expect(bearingOf(rotated, frame.rotate.artwork)).toBeCloseTo(target, 6);
  }
});

test("rotation stays inside (-180, 180]", () => {
  for (const target of [0, 90, 179, -179, 270, -270]) {
    const rotationDeg = rotationForHandle([50, 150], [50, 50], target);
    expect(rotationDeg).toBeGreaterThan(-180);
    expect(rotationDeg).toBeLessThanOrEqual(180);
  }
});

test("a rotation handle on the anchor is rejected", () => {
  expect(() => rotationForHandle([50, 50], [50, 50], 0)).toThrow();
});

test("the gizmo frame rotates with the artwork", () => {
  const rotated: SimilarityTransform = { ...UNROTATED, rotationDeg: 90 };
  const frame = gizmoFrame(rotated, BOX);
  // 90 deg CCW from north sends the artwork's +y axis due west.
  expect(bearingOf(rotated, frame.rotate.artwork)).toBeCloseTo(-90, 6);
});

test("transformGeoJson walks a GeometryCollection instead of crashing on it", () => {
  // The importer can emit a GeometryCollection for degenerate artwork; a
  // collection has `geometries`, not `coordinates`, so a naive walk reads
  // undefined[0] and takes the whole placement screen down.
  const collection = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature",
        properties: { ai_layer: "floor" },
        geometry: {
          type: "GeometryCollection",
          geometries: [
            { type: "Polygon", coordinates: [GOLDEN_ARTWORK] },
            { type: "LineString", coordinates: [GOLDEN_ARTWORK[0], GOLDEN_ARTWORK[1]] }
          ]
        }
      }
    ]
  };

  const placed = transformGeoJson(collection, GOLDEN);
  const geometry = placed.features[0].geometry;
  expect(geometry.type).toBe("GeometryCollection");
  expect(geometry.geometries).toHaveLength(2);
  // Each member is transformed, matching the golden constants.
  const ring = geometry.geometries[0].coordinates[0];
  expect(ring[0][0]).toBeCloseTo(GOLDEN_LNGLAT[0][0], 6);
  expect(ring[0][1]).toBeCloseTo(GOLDEN_LNGLAT[0][1], 6);
  expect(geometry.geometries[1].coordinates[1][0]).toBeCloseTo(GOLDEN_LNGLAT[1][0], 6);
});

test("transformGeoJson leaves a geometry with no coordinates untouched", () => {
  const collection = {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature", properties: {}, geometry: null }]
  };
  expect(() => transformGeoJson(collection, GOLDEN)).not.toThrow();
  expect(transformGeoJson(collection, GOLDEN).features[0].geometry).toBeNull();
});
