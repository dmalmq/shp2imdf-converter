import { hubProjects, lifetime, matchesFilter, routeDroppedFiles, toHubProject } from "./hub";
import { projectSummary as summary } from "./hub.fixtures";

function statuses(project: ReturnType<typeof toHubProject>) {
  return project.track.map((stage) => stage.status);
}

test("most recently opened first, ties broken by id", () => {
  const list = hubProjects([
    summary({ id: "old", last_opened: "2026-08-18T03:00:00Z" }),
    summary({ id: "b", last_opened: "2026-09-12T03:00:00Z" }),
    summary({ id: "new", flow: "artwork", stage: "place", last_opened: "2026-09-24T03:00:00Z" }),
    summary({ id: "a", last_opened: "2026-09-12T03:00:00Z" })
  ]);
  expect(list.map((project) => project.id)).toEqual(["new", "a", "b", "old"]);
});

test.each([
  ["bring-in", "/p/s1"],
  [null, "/p/s1"],
  ["set-up", "/p/s1/set-up"],
  ["check", "/p/s1/check"],
  ["deliver", "/p/s1/deliver"]
] as const)("a shapefile project at %s continues at %s", (stage, href) => {
  expect(toHubProject(summary({ stage })).href).toBe(href);
});

test.each(["name-floors", "place", "deliver", null] as const)("an artwork project at %s opens the artwork route", (stage) => {
  expect(toHubProject(summary({ flow: "artwork", stage, can_wait: null })).href).toBe("/illustrator");
});

test("ids are escaped in the route", () => {
  expect(toHubProject(summary({ id: "a/b", stage: "check" })).href).toBe("/p/a%2Fb/check");
});

test("a shapefile project at Check with errors has a rust current stage and things to fix", () => {
  const project = toHubProject(summary());
  expect(statuses(project)).toEqual(["done", "done", "current", "todo"]);
  expect(project.track[2].detailTone).toBe("danger");
  expect(project.stageNumber).toBe(3);
  expect(project.status).toEqual({ kind: "to-fix", count: 3 });
  expect(project.action).toBe("continue");
});

test("artwork still to place is a warning at Place on map", () => {
  const project = toHubProject(summary({ flow: "artwork", stage: "place", blockers: 3, can_wait: null }));
  expect(project.track.map((stage) => stage.id)).toEqual(["bring-in-artwork", "name-floors", "place", "deliver"]);
  expect(statuses(project)).toEqual(["done", "done", "current", "todo"]);
  expect(project.track[2].detailTone).toBe("warning");
  expect(project.status).toEqual({ kind: "to-place", count: 3 });
});

test("delivered and unchanged: every stage done, and Open", () => {
  const project = toHubProject(
    summary({ stage: "deliver", blockers: 0, delivered_at: "2026-09-12T03:00:00Z" })
  );
  expect(statuses(project)).toEqual(["done", "done", "done", "done"]);
  expect(project.status).toEqual({ kind: "delivered", at: "2026-09-12T03:00:00Z" });
  expect(project.action).toBe("open");
  expect(project.deliveredBeforeChanges).toBeNull();
});

test("delivered then changed: back to work, and the delivery is remembered", () => {
  const project = toHubProject(
    summary({ stage: "check", blockers: 1, delivered_at: "2026-09-12T03:00:00Z", changed_since_delivery: true })
  );
  expect(project.action).toBe("continue");
  expect(project.status).toEqual({ kind: "to-fix", count: 1 });
  expect(project.deliveredBeforeChanges).toBe("2026-09-12T03:00:00Z");
});

test("no validation yet reads as unchecked; a clean one as ready", () => {
  expect(toHubProject(summary({ stage: "set-up", blockers: null, can_wait: null })).status).toEqual({ kind: "unchecked" });
  expect(toHubProject(summary({ stage: "deliver", blockers: 0, can_wait: 2 })).status).toEqual({ kind: "ready", canWait: 2 });
});

test("a nameless project keeps a null name for the card to fall back on", () => {
  expect(toHubProject(summary({ name: "  " })).name).toBeNull();
});

test("filters split delivered from in progress", () => {
  const [working, delivered] = hubProjects([
    summary({ id: "w", last_opened: "2026-09-20T03:00:00Z" }),
    summary({ id: "d", last_opened: "2026-09-19T03:00:00Z", stage: "deliver", delivered_at: "2026-09-19T03:00:00Z" })
  ]);
  expect([matchesFilter(working, "in-progress"), matchesFilter(working, "delivered")]).toEqual([true, false]);
  expect([matchesFilter(delivered, "in-progress"), matchesFilter(delivered, "delivered")]).toEqual([false, true]);
  expect(matchesFilter(delivered, "all")).toBe(true);
});

test("lifetimes under a day are stated in hours", () => {
  expect(lifetime({ idle_days: 30, max_projects: 200 })).toEqual({ unit: "days", value: 30 });
  expect(lifetime({ idle_days: 2 / 24, max_projects: 20 })).toEqual({ unit: "hours", value: 2 });
});

function named(name: string, body = "x") {
  return new File([body], name);
}

describe("drop routing", () => {
  test("shapefile parts, GeoPackages and a shapefile zip go to Bring in", async () => {
    const zip = named("JRTokyoSta.zip", "PK\u0001\u0002....JRTokyoSta_B1_Space.shp....JRTokyoSta_B1_Space.dbf");
    const files = [named("JRTokyoSta_B1_Space.shp"), named("JRTokyoSta_B1_Space.dbf"), named("site.gpkg"), zip];
    expect(await routeDroppedFiles(files)).toEqual({ route: "shapefiles", files });
  });

  test.each(["0001_東京.ai", "floors.PDF"])("%s goes to the artwork flow", async (name) => {
    const file = named(name);
    expect(await routeDroppedFiles([file])).toEqual({ route: "artwork", files: [file] });
  });

  test("an IMDF archive is recognised by extension or by its manifest", async () => {
    const byExtension = named("tokyo.imdf");
    const byName = named("tokyo.imdf.zip");
    const byManifest = named("export.zip", "PK\u0003\u0004...PK\u0001\u0002....manifest.json....venue.geojson");
    for (const file of [byExtension, byName, byManifest]) {
      expect(await routeDroppedFiles([file])).toEqual({ route: "imdf", files: [file] });
    }
  });

  test("files that fit no route are left out, and a drop of only those is refused", async () => {
    const shp = named("a.shp");
    expect(await routeDroppedFiles([shp, named("notes.txt")])).toEqual({ route: "shapefiles", files: [shp] });
    expect(await routeDroppedFiles([named("notes.txt")])).toEqual({ route: null, reason: "unsupported" });
  });

  test("a drop that mixes routes, or holds two artworks, is refused", async () => {
    expect(await routeDroppedFiles([named("a.shp"), named("b.ai")])).toEqual({ route: null, reason: "mixed" });
    expect(await routeDroppedFiles([named("a.ai"), named("b.pdf")])).toEqual({ route: null, reason: "several" });
  });
});
