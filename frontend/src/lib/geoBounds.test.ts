import { computeGeoBounds } from "./geoBounds";

test("a single point frames as a degenerate box", () => {
  expect(computeGeoBounds([{ geometry: { coordinates: [139.7, 35.6] } }])).toEqual([
    [139.7, 35.6],
    [139.7, 35.6]
  ]);
});

test("a line spans its extremes", () => {
  const bounds = computeGeoBounds([
    {
      geometry: {
        coordinates: [
          [139.7, 35.6],
          [139.9, 35.5],
          [139.8, 35.8]
        ]
      }
    }
  ]);
  expect(bounds).toEqual([
    [139.7, 35.5],
    [139.9, 35.8]
  ]);
});

test("polygon rings and their holes are both walked", () => {
  const bounds = computeGeoBounds([
    {
      geometry: {
        coordinates: [
          [
            [139.7, 35.6],
            [139.8, 35.6],
            [139.8, 35.7],
            [139.7, 35.6]
          ],
          [
            [139.72, 35.62],
            [139.75, 35.62],
            [139.75, 35.65],
            [139.72, 35.62]
          ]
        ]
      }
    }
  ]);
  expect(bounds).toEqual([
    [139.7, 35.6],
    [139.8, 35.7]
  ]);
});

test("multipolygon nesting is walked to the positions", () => {
  const bounds = computeGeoBounds([
    {
      geometry: {
        coordinates: [
          [
            [
              [139.7, 35.6],
              [139.75, 35.65],
              [139.7, 35.6]
            ]
          ],
          [
            [
              [140.1, 35.2],
              [140.2, 35.3],
              [140.1, 35.2]
            ]
          ]
        ]
      }
    }
  ]);
  expect(bounds).toEqual([
    [139.7, 35.2],
    [140.2, 35.65]
  ]);
});

test("a third ordinate is elevation, not latitude", () => {
  expect(computeGeoBounds([{ geometry: { coordinates: [139.7, 35.6, 120.5] } }])).toEqual([
    [139.7, 35.6],
    [139.7, 35.6]
  ]);
});

test("features of mixed geometry types share one box", () => {
  const bounds = computeGeoBounds([
    { geometry: { coordinates: [139.7, 35.6] } },
    {
      geometry: {
        coordinates: [
          [139.5, 35.9],
          [139.6, 35.4]
        ]
      }
    }
  ]);
  expect(bounds).toEqual([
    [139.5, 35.4],
    [139.7, 35.9]
  ]);
});

test("features without a position yield no box", () => {
  expect(computeGeoBounds([])).toBeNull();
  expect(computeGeoBounds([{ geometry: null }, {}])).toBeNull();
  expect(computeGeoBounds([{ geometry: { coordinates: undefined } }])).toBeNull();
  expect(computeGeoBounds([{ geometry: { coordinates: [] } }])).toBeNull();
});

test("non-numeric and non-finite positions are ignored", () => {
  expect(computeGeoBounds([{ geometry: { coordinates: [Number.NaN, 35.6] } }])).toBeNull();
  expect(computeGeoBounds([{ geometry: { coordinates: [Number.POSITIVE_INFINITY, 35.6] } }])).toBeNull();
  expect(computeGeoBounds([{ geometry: { coordinates: ["139.7", 35.6] } }])).toBeNull();
});

test("a bad position does not discard the good ones around it", () => {
  const bounds = computeGeoBounds([
    { geometry: { coordinates: [Number.NaN, Number.NaN] } },
    { geometry: { coordinates: [139.7, 35.6] } },
    { geometry: { coordinates: [139.9, 35.8] } }
  ]);
  expect(bounds).toEqual([
    [139.7, 35.6],
    [139.9, 35.8]
  ]);
});

test("a dataset-sized ring is scanned in one pass", () => {
  const ring: [number, number][] = [];
  for (let index = 0; index < 50_000; index += 1) {
    ring.push([139.7 + index * 1e-6, 35.6 + index * 1e-6]);
  }
  expect(computeGeoBounds([{ geometry: { coordinates: [ring] } }])).toEqual([
    [139.7, 35.6],
    [139.7 + 49_999 * 1e-6, 35.6 + 49_999 * 1e-6]
  ]);
});
