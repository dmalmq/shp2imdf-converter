import {
  artworkStages,
  datasetStem,
  flowForPath,
  landingStage,
  parseProjectPath,
  projectPath,
  shapefileStages,
  stageReachable,
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
  sessionId: null,
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

  test("Bring in counts the files that need a decision", () => {
    const stages = shapefileStages({ ...base, pathname: "/p/s1/bring-in", sessionId: "s1", page: { bringInNeeds: 2 } });
    expect(stages[0].detail).toEqual({ en: "2 files need you", ja: "確認が必要なファイル 2 件" });
    expect(stages[0].detailTone).toBe("danger");
    const settled = shapefileStages({ ...base, pathname: "/p/s1/bring-in", sessionId: "s1", page: { bringInNeeds: 0 } });
    expect(settled[0].detail).toBeUndefined();
  });

  test("the wizard is Set up, with Bring in behind it", () => {
    const stages = shapefileStages({ ...base, pathname: "/p/s1/set-up", sessionId: "s1" });
    expect(statuses(stages)).toEqual(["done", "current", "todo", "todo"]);
    expect(targets(stages)).toEqual(["/p/s1/bring-in", null, null, null]);
  });

  test("Check opens from the wizard once Review has been reached", () => {
    const stages = shapefileStages({ ...base, pathname: "/p/s1/set-up", sessionId: "s1", reviewReached: true });
    expect(statuses(stages)).toEqual(["done", "current", "todo", "todo"]);
    expect(targets(stages)).toEqual(["/p/s1/bring-in", null, "/p/s1/check", "/p/s1/deliver"]);
  });

  test("Check is blocked from the wizard while Generate cannot run", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/p/s1/set-up",
      sessionId: "s1",
      page: { nextBlockedReason: { en: "Finish sections", ja: "未完了" } }
    });
    expect(statuses(stages)).toEqual(["done", "current", "blocked", "todo"]);
  });

  test("Review is Check; Deliver goes to the page's export dialog", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/p/s1/check",
      sessionId: "s1",
      reviewReached: true,
      page: { targets: ["deliver"], checkErrors: 3 }
    });
    expect(statuses(stages)).toEqual(["done", "done", "current", "todo"]);
    expect(targets(stages)).toEqual(["/p/s1/bring-in", "/p/s1/set-up", null, "page"]);
    expect(stages[2].detail).toEqual({ en: "3 to fix", ja: "要修正 3 件" });
    expect(stages[2].detailTone).toBe("danger");
  });

  test("Check says so when validation found nothing", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/p/s1/check",
      sessionId: "s1",
      reviewReached: true,
      page: { checkErrors: 0 }
    });
    expect(stages[2].detail?.en).toBe("Nothing to fix");
    expect(stages[2].detailTone).toBe("default");
  });

  test("an open export dialog makes Deliver current", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/p/s1/check",
      sessionId: "s1",
      reviewReached: true,
      page: { current: "deliver", targets: ["deliver"] }
    });
    expect(statuses(stages)).toEqual(["done", "done", "done", "current"]);
    expect(stages[3].target).toBeUndefined();
  });

  test("IMDF shapefile imports skip Set up, so it is never a link", () => {
    const stages = shapefileStages({
      ...base,
      pathname: "/p/s1/check",
      sessionId: "s1",
      importProfile: "imdf_shapefile",
      reviewReached: true
    });
    expect(statuses(stages)).toEqual(["done", "done", "current", "todo"]);
    expect(targets(stages)[1]).toBeNull();
    expect(stages[1].detail?.en).toBe("Not needed for IMDF shapefiles");
  });

  test("back on Bring in with a session, the later stages stay reachable", () => {
    const stages = shapefileStages({ ...base, sessionId: "s1", reviewReached: true });
    expect(statuses(stages)).toEqual(["current", "done", "todo", "todo"]);
    expect(targets(stages)).toEqual([null, "/p/s1/set-up", "/p/s1/check", "/p/s1/deliver"]);
  });

  test("with a session that has not reached Review, Check is not a link", () => {
    const stages = shapefileStages({ ...base, sessionId: "s1" });
    expect(statuses(stages)).toEqual(["current", "todo", "todo", "todo"]);
    expect(targets(stages)).toEqual([null, "/p/s1/set-up", null, null]);
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
  expect(flowForPath("/p/s1/check")).toBe("shapefiles");
});

describe("project URLs", () => {
  test("round-trip the id and stage", () => {
    expect(projectPath("abc", "set-up")).toBe("/p/abc/set-up");
    expect(parseProjectPath("/p/abc/set-up")).toEqual({ sessionId: "abc", stage: "set-up" });
    expect(parseProjectPath("/p/abc")).toEqual({ sessionId: "abc", stage: null });
    expect(parseProjectPath("/p/abc/")).toEqual({ sessionId: "abc", stage: null });
    expect(parseProjectPath("/")).toBeNull();
    expect(parseProjectPath("/illustrator")).toBeNull();
  });

  test("the stage in the URL is the current stage", () => {
    const at = (stage: string) =>
      statuses(shapefileStages({ ...base, pathname: `/p/s1/${stage}`, sessionId: "s1", reviewReached: true }));
    expect(at("bring-in")).toEqual(["current", "done", "todo", "todo"]);
    expect(at("set-up")).toEqual(["done", "current", "todo", "todo"]);
    expect(at("check")).toEqual(["done", "done", "current", "todo"]);
    expect(at("deliver")).toEqual(["done", "done", "done", "current"]);
  });

  const projects = [
    { importProfile: "standard", reviewReached: false },
    { importProfile: "standard", reviewReached: true },
    { importProfile: "imdf_shapefile", reviewReached: false },
    { importProfile: "imdf_shapefile", reviewReached: true }
  ] as const;

  test.each(projects)("the landing stage is reachable, so a redirect to it cannot loop (%o)", (project) => {
    expect(stageReachable(landingStage(project), project)).toBe(true);
  });

  test("Check and Deliver wait for a draft; Set up is closed to IMDF shapefiles", () => {
    const fresh = { importProfile: "standard", reviewReached: false } as const;
    expect(stageReachable("bring-in", fresh)).toBe(true);
    expect(stageReachable("set-up", fresh)).toBe(true);
    expect(stageReachable("check", fresh)).toBe(false);
    expect(stageReachable("deliver", fresh)).toBe(false);
    expect(landingStage(fresh)).toBe("set-up");

    const imdf = { importProfile: "imdf_shapefile", reviewReached: false } as const;
    expect(stageReachable("set-up", imdf)).toBe(false);
    expect(landingStage(imdf)).toBe("check");
  });
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
