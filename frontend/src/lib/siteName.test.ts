import { siteNameFromFilename } from "./siteName";

test("drops the work-order number and extension", () => {
  expect(siteNameFromFilename("0307_大井町.ai")).toBe("大井町");
});

test("drops a trailing CRS or sheet number", () => {
  expect(siteNameFromFilename("JRShinjukuSta_6677.ai")).toBe("JRShinjukuSta");
});

test("drops repeated leading numbers and a copy suffix", () => {
  expect(siteNameFromFilename("2024_03_大井町 (1).ai")).toBe("大井町");
});

test("underscores inside the name become spaces", () => {
  expect(siteNameFromFilename("0307_Tokyo_Station.ai")).toBe("Tokyo Station");
});

test("a bare name survives unchanged", () => {
  expect(siteNameFromFilename("東京駅.ai")).toBe("東京駅");
  expect(siteNameFromFilename("sample.pdf")).toBe("sample");
});

test("a path is reduced to its file name", () => {
  expect(siteNameFromFilename("C:\\drawings\\0307_大井町.ai")).toBe("大井町");
  expect(siteNameFromFilename("/drawings/0307_大井町.ai")).toBe("大井町");
});

test("a purely numeric name yields no search term", () => {
  expect(siteNameFromFilename("12345.ai")).toBe("");
  expect(siteNameFromFilename("0307_.ai")).toBe("");
});
