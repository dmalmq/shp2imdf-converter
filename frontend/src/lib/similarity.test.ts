import {
  applyMatrix,
  enuToLngLat,
  fitHelmert,
  lngLatToEnu,
  metresPerPointForScale,
  residuals,
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
