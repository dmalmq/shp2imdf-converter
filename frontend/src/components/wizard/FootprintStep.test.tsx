import { polygonsToSvgPaths } from "./FootprintStep";

test("footprint path data holds bare numbers only, which is all SVG accepts", () => {
  const d = polygonsToSvgPaths(
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0]
      ]
    ],
    0,
    0,
    2
  );

  expect(d).toBe("M16.0,304.0L36.0,304.0L36.0,284.0L16.0,304.0Z");
  expect(d).toMatch(/^(M-?\d+(\.\d+)?,-?\d+(\.\d+)?(L-?\d+(\.\d+)?,-?\d+(\.\d+)?)*Z)+$/);
});
