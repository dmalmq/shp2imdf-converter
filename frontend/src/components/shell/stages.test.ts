import {
  artworkStages,
  datasetStem,
  flowForPath,
  shapefileStages,
  stationName,
  type ShapefileInput,
  type Stage
} from "./stages";

const statuses = (stages: Stage[]) => stages.map((stage) => stage.status);
const targets = (stages: Stage[]) =>
  stages.map((stage) =>
    stage.target?.kind === "route" ? stage.target.to : stage.target?.kind === "page" ? "page" : null
  );

const base: ShapefileInput = {
  pathname: "/",
  hasSession: false,
  importProfile: "standard",
  reviewReached: false
};

describe("shapefile flow", () => {
  test("a fresh Bring in has nothing further to go to", () => {
    const stages = shapefileStages(base);
    expect(stages.map((stage) => stage.label.en)).toEqual(["Bring in", "Set up", "Check", "Deliver"]);
    expect(statuses(stages)).toEqual(["current", "todo", "todo", "todo"]);
    expect(targets(stages)).toEqual([null, null, null, null]);
  });

  test("Set up is blocked, with the reason, while Import cannot run", () => {
    const stages = shapefileStages({
      ...base,
      page: { nextBlockedReason: { en: "Add a file", ja: "ファイルを追加" } }
    });
    expect(statuses(stages)).toEqual(["current", "blocked", "todo", "todo"]);
    expect(stages[1].detail?.en).toBe("Add a file");
  });

  test("the wizard is Set up, with Bring in behind it", () => {
    const stages = shapefileStages({ ...base, pathname: "/wizard", hasSession: true });
    expect(statuses(stages)).toEqual(["done", "current", "todo", "todo"]);
    expect(targets(stages)).toEqual(["/", null, null, null]);
  });

  test("Check opens from the wizard once Review has been reached", () => {
    const stages = shapefileStages({ ...base, pathname: "/wizard", hasSession: true, reviewReached: true });
    expect(statuses(stages)).toEqual(["done", "current", "todo", "todo"]);
    expect(targets(stages)).toEqual(["/", null, "/review", null]);
  });

  test("Check is blocked from the wizard while Generate cannot run", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/wizard",
      hasSession: true,
      page: { nextBlockedReason: { en: "Finish sections", ja: "未完了" } }
    });
    expect(statuses(stages)).toEqual(["done", "current", "blocked", "todo"]);
  });

  test("Review is Check; Deliver goes to the page's export dialog", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/review",
      hasSession: true,
      reviewReached: true,
      page: { targets: ["deliver"], checkErrors: 3 }
    });
    expect(statuses(stages)).toEqual(["done", "done", "current", "todo"]);
    expect(targets(stages)).toEqual(["/", "/wizard", null, "page"]);
    expect(stages[2].detail).toEqual({ en: "3 to fix", ja: "要修正 3 件" });
    expect(stages[2].detailTone).toBe("danger");
  });

  test("Check says so when validation found nothing", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/review",
      hasSession: true,
      reviewReached: true,
      page: { checkErrors: 0 }
    });
    expect(stages[2].detail?.en).toBe("Nothing to fix");
    expect(stages[2].detailTone).toBe("default");
  });

  test("an open export dialog makes Deliver current", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/review",
      hasSession: true,
      reviewReached: true,
      page: { current: "deliver", targets: ["deliver"] }
    });
    expect(statuses(stages)).toEqual(["done", "done", "done", "current"]);
    expect(stages[3].target).toBeUndefined();
  });

  test("IMDF shapefile imports skip Set up, so it is never a link", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/review",
      hasSession: true,
      importProfile: "imdf_shapefile",
      reviewReached: true
    });
    expect(statuses(stages)).toEqual(["done", "done", "current", "todo"]);
    expect(targets(stages)[1]).toBeNull();
    expect(stages[1].detail?.en).toBe("Not needed for IMDF shapefiles");
  });

  test("back on Bring in with a session, the later stages stay reachable", () => {
    const stages = shapefileStages({ ...base, hasSession: true, reviewReached: true });
    expect(statuses(stages)).toEqual(["current", "done", "todo", "todo"]);
    expect(targets(stages)).toEqual([null, "/wizard", "/review", null]);
  });

  test("with a session that has not reached Review, Check is not a link", () => {
    const stages = shapefileStages({ ...base, hasSession: true });
    expect(statuses(stages)).toEqual(["current", "todo", "todo", "todo"]);
    expect(targets(stages)).toEqual([null, "/wizard", null, null]);
  });
});

describe("artwork flow", () => {
  test("follows the Illustrator route's stage", () => {
    expect(statuses(artworkStages({ illustratorStage: 1 }))).toEqual(["current", "todo", "todo", "todo"]);
    expect(statuses(artworkStages({ illustratorStage: 2 }))).toEqual(["done", "current", "todo", "todo"]);
    expect(statuses(artworkStages({ illustratorStage: 3 }))).toEqual(["done", "done", "current", "todo"]);
    expect(artworkStages({ illustratorStage: 1 }).map((stage) => stage.label.en)).toEqual([
      "Bring in artwork",
      "Name floors",
      "Place on map",
      "Deliver"
    ]);
  });

  test("stages are links only where the page can switch to them", () => {
    expect(targets(artworkStages({ illustratorStage: 2 }))).toEqual([null, null, null, null]);
    const placing = artworkStages({ illustratorStage: 3, page: { targets: ["deliver"] } });
    expect(targets(placing)).toEqual([null, null, null, "page"]);
    const delivering = artworkStages({ illustratorStage: 3, page: { current: "deliver", targets: ["place"] } });
    expect(statuses(delivering)).toEqual(["done", "done", "done", "current"]);
    expect(targets(delivering)).toEqual([null, null, "page", null]);
  });
});

test("the Illustrator route is the artwork flow; every other route is shapefiles", () => {
  expect(flowForPath("/illustrator")).toBe("artwork");
  expect(flowForPath("/")).toBe("shapefiles");
  expect(flowForPath("/review")).toBe("shapefiles");
});

describe("station name", () => {
  const wizard = (venue: string, project: string) =>
    ({ project: { venue_name: venue, project_name: project } }) as unknown as Parameters<typeof stationName>[0];

  test("prefers the venue, then the project name", () => {
    expect(stationName(wizard("東京駅", "Tokyo"), [])).toBe("東京駅");
    expect(stationName(wizard("  ", "Tokyo"), [])).toBe("Tokyo");
  });

  test("falls back to the stem the uploaded files share", () => {
    const files = [{ stem: "JRTokyoSta_B1_Space" }, { stem: "JRTokyoSta_1_Opening" }];
    expect(stationName(null, files)).toBe("JRTokyoSta");
    expect(stationName(wizard("", ""), files)).toBe("JRTokyoSta");
  });

  test("is omitted when nothing is known", () => {
    expect(stationName(null, [])).toBeNull();
    expect(stationName(null, [{ stem: "units" }, { stem: "openings" }])).toBeNull();
  });

  test("a single file is its own stem", () => {
    expect(datasetStem(["station__units"])).toBe("station__units");
  });
});
