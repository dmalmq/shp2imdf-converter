import type { BuildingWizardState, ImportedFile, ProjectWizardState } from "../api/client";
import { codeName, setUpView, withCurrent, type SetUpInput } from "./setUp";

function file(stem: string, overrides: Partial<ImportedFile> = {}): ImportedFile {
  return {
    stem,
    geometry_type: "Polygon",
    feature_count: 3,
    attribute_columns: [],
    source_format: "shapefile",
    source_layer: null,
    detected_type: "unit",
    detected_level: 0,
    level_name: null,
    short_name: null,
    outdoor: false,
    level_category: "unspecified",
    confidence: "green",
    crs_detected: null,
    warnings: [],
    ...overrides
  };
}

const PROJECT: ProjectWizardState = {
  project_name: null,
  venue_name: "東京駅",
  venue_category: "transitstation",
  language: "ja",
  venue_restriction: null,
  venue_hours: null,
  venue_phone: null,
  venue_website: null,
  address: {
    address: null,
    unit: null,
    locality: "千代田区",
    province: null,
    country: "JP",
    postal_code: null,
    postal_code_ext: null,
    postal_code_vanity: null
  }
};

const BUILDING: BuildingWizardState = {
  id: "b1",
  name: null,
  category: "unspecified",
  restriction: null,
  file_stems: ["JRTokyoSta_1_Space"],
  address_mode: "same_as_venue",
  address: null,
  address_feature_id: null
};

function input(overrides: Partial<SetUpInput> = {}): SetUpInput {
  return {
    files: [file("JRTokyoSta_1_Space")],
    project: PROJECT,
    buildings: [BUILDING],
    buildingsHeld: false,
    wizard: null,
    ...overrides
  };
}

const ids = (view: ReturnType<typeof setUpView>) => view.checklist.map((item) => [item.id, item.done]);

test("a missing unit code column is the one thing left", () => {
  const view = setUpView(input());
  expect(view.left).toBe(1);
  expect(view.canGenerate).toBe(false);
  expect(view.checklist[0]).toMatchObject({ id: "unit-column", fix: "unit", done: false });
  expect(view.sections.map((section) => [section.id, section.done])).toEqual([
    ["project", true],
    ["levels", true],
    ["attributes", false],
    ["summary", false]
  ]);
});

test("missing items come first, each with the field its Fix goes to", () => {
  const view = setUpView(input({ project: { ...PROJECT, venue_name: " ", address: { ...PROJECT.address, country: "" } }, files: [] }));
  expect(ids(view)).toEqual([
    ["venue-name", false],
    ["country", false],
    ["venue-category", true],
    ["locality", true],
    ["buildings", true],
    ["file-types", true],
    ["levels", true]
  ]);
  expect(view.checklist[1]).toMatchObject({ fix: "project-info", field: "country" });
});

test("a file with no type sends Fix back to Bring in, and a file with no floor to Level mapping", () => {
  const view = setUpView(input({ files: [file("qwzx", { detected_type: null }), file("JRTokyoSta_1_Space", { detected_level: null })] }));
  const missing = view.checklist.filter((item) => !item.done);
  expect(missing.map((item) => [item.id, item.fix])).toEqual([
    ["file-types", "bring-in"],
    ["levels", "levels"],
    ["unit-column", "unit"]
  ]);
});

test("a held buildings draft is not done, and unit files add their mapping to the rail", () => {
  const view = setUpView(input({ buildingsHeld: true }));
  expect(view.checklist.find((item) => item.id === "buildings")?.done).toBe(false);
  const attributes = view.sections.find((section) => section.id === "attributes");
  expect(attributes?.children?.filter((child) => !child.hidden).map((child) => child.id)).toEqual(["unit"]);
});

test("codes are named in the UI language, and a stored value outside the list is kept", () => {
  expect(codeName("region", "JP", "en")).toBe("Japan");
  expect(codeName("region", "JP", "ja")).toBe("日本");
  expect(codeName("language", "ja", "en")).toBe("Japanese");
  expect(withCurrent(["ja", "en"], "fr")).toEqual(["fr", "ja", "en"]);
  expect(withCurrent(["ja", "en"], "en")).toEqual(["ja", "en"]);
});
