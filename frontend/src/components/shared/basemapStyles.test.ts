import { BASEMAP_ORDER, BASEMAP_STYLES, basemapLabel, isImageryBasemap } from "./basemapStyles";

test("every basemap in the order has a style", () => {
  for (const id of BASEMAP_ORDER) {
    expect(BASEMAP_STYLES[id]).toBeDefined();
  }
});

test("OSM stays the first and default option", () => {
  expect(BASEMAP_ORDER[0]).toBe("osm");
});

test("aerial imagery is offered, because OSM often lacks the footprint", () => {
  expect(BASEMAP_ORDER).toContain("gsi-photo");
});

test("every style carries an attribution", () => {
  for (const id of BASEMAP_ORDER) {
    const sources = Object.values(BASEMAP_STYLES[id].sources) as { attribution?: string }[];
    for (const source of sources) {
      expect(source.attribution).toBeTruthy();
    }
  }
});

test("GSI layers credit 国土地理院 as their terms require", () => {
  for (const id of ["gsi-photo", "gsi-std"] as const) {
    const sources = Object.values(BASEMAP_STYLES[id].sources) as { attribution?: string }[];
    expect(sources.some((source) => source.attribution?.includes("国土地理院"))).toBe(true);
  }
});

test("tile templates use xyz placeholders", () => {
  for (const id of BASEMAP_ORDER) {
    const sources = Object.values(BASEMAP_STYLES[id].sources) as { tiles?: string[] }[];
    for (const source of sources) {
      // All three placeholders present; Esri uses {z}/{y}/{x}, the others {z}/{x}/{y}.
      expect(source.tiles?.[0]).toMatch(/\{z\}/);
      expect(source.tiles?.[0]).toMatch(/\{x\}/);
      expect(source.tiles?.[0]).toMatch(/\{y\}/);
    }
  }
});

test("styles paint a background so a failed tile fetch is not a white void", () => {
  for (const id of BASEMAP_ORDER) {
    const background = BASEMAP_STYLES[id].layers.find((layer) => layer.type === "background");
    expect(background).toBeDefined();
  }
});

test("labels are bilingual", () => {
  const en = (a: string) => a;
  const ja = (_a: string, b: string) => b;
  expect(basemapLabel("gsi-photo", en)).toBe("Aerial (GSI)");
  expect(basemapLabel("gsi-photo", ja)).toBe("写真（地理院）");
  expect(basemapLabel("esri", en)).toBe("Satellite (Esri)");
  expect(basemapLabel("esri", ja)).toBe("衛星写真（Esri）");
});

test("a blank ground is offered, because aligning two floors is not a question about the world", () => {
  expect(BASEMAP_ORDER).toContain("blank");
  expect(BASEMAP_ORDER[0]).not.toBe("blank");
});

test("the blank style fetches nothing, so the attribution and tile rules above pass it vacuously", () => {
  expect(BASEMAP_STYLES.blank.sources).toEqual({});
});

test("blank paints white, not the grey that means tiles have not arrived", () => {
  const background = BASEMAP_STYLES.blank.layers.find((layer) => layer.type === "background");
  expect(background?.paint).toEqual({ "background-color": "#ffffff" });
});

test("blank is not imagery, so ghost floors stay ink rather than flipping to paper", () => {
  expect(isImageryBasemap("blank")).toBe(false);
});

test("blank is named as an absence in both languages", () => {
  const en = (a: string) => a;
  const ja = (_a: string, b: string) => b;
  expect(basemapLabel("blank", en)).toBe("No map");
  expect(basemapLabel("blank", ja)).toBe("地図なし");
});
