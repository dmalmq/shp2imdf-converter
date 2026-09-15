import {
  ARTWORK_SLOT_LAYER_ID,
  artworkLayerFilter,
  OVERLAY_SLOT_LAYER_ID,
  floorFillLayerId,
  floorLineLayerId,
  floorSourceId,
  layerVisibility,
  referenceFillLayerId,
  referenceLineLayerId,
  referencePointLayerId,
  referenceSourceId
} from "./placementMapLayers";

test("a floor keeps the same source and layer ids whether it is active or a ghost", () => {
  // Switching the selected floor used to remount <Source> with a new React key
  // (`ghost-1F` vs `1F`) while reusing MapLibre id `floor-1F`. That race blanks
  // the canvas. These ids must not encode active vs ghost.
  expect(floorSourceId("1F")).toBe("floor-1F");
  expect(floorFillLayerId("1F")).toBe("floor-1F-fill");
  expect(floorLineLayerId("1F")).toBe("floor-1F-line");
  expect(floorFillLayerId("1F")).not.toMatch(/ghost/);
  expect(floorFillLayerId("2F")).toBe("floor-2F-fill");
  expect(floorSourceId("1F")).not.toMatch(/solid|transparent|ghost|hidden/);
  expect(floorFillLayerId("1F")).not.toMatch(/solid|transparent|ghost|hidden/);
  expect(floorLineLayerId("1F")).not.toMatch(/solid|transparent|ghost|hidden/);
});

test("hiding a reference shapefile does not change its source id", () => {
  expect(referenceSourceId("survey")).toBe("reference-survey");
  expect(referenceFillLayerId("survey")).toBe("reference-survey-fill");
  expect(referenceLineLayerId("survey")).toBe("reference-survey-line");
  expect(referencePointLayerId("survey")).toBe("reference-survey-point");
});

test("isolate-this-floor is a visibility flag, not a different layer id", () => {
  expect(layerVisibility(true)).toBe("visible");
  expect(layerVisibility(false)).toBe("none");
  expect(floorSourceId("1F")).toBe(floorSourceId("1F"));
});

test("artwork layer filters hide names without changing floor sources", () => {
  expect(artworkLayerFilter([], false)).toBeUndefined();
  expect(artworkLayerFilter([], true)).toEqual(["==", ["geometry-type"], "Polygon"]);

  const hidden = ["Walls", "Labels"];
  const visibility = [
    "!",
    [
      "in",
      ["coalesce", ["get", "ai_layer"], ["get", "source_table"], ""],
      ["literal", hidden]
    ]
  ];
  expect(artworkLayerFilter(hidden, false)).toEqual(visibility);
  expect(artworkLayerFilter(hidden, true)).toEqual([
    "all",
    ["==", ["geometry-type"], "Polygon"],
    visibility
  ]);
  expect(floorSourceId("1F")).toBe("floor-1F");
});

test("slot layers have stable ids so beforeId never points at a missing layer", () => {
  expect(ARTWORK_SLOT_LAYER_ID).toBe("placement-artwork-start");
  expect(OVERLAY_SLOT_LAYER_ID).toBe("placement-overlay-end");
});
