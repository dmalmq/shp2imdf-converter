import { describe, expect, it } from "vitest";

import {
  countTile,
  drawnFrom,
  emptyTileStats,
  folderFiles,
  groupLayers,
  groupOf,
  inflate,
  noTilesFound,
  prepareStyle,
  protocolPath,
  resolvePath,
  soloVisibility,
  stepFloor,
  tileBounds,
  tileLevels,
  type TileIndex
} from "./vtiles";

const encode = (value: unknown, bom = false): ArrayBuffer => {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(body.length + (bom ? 3 : 0));
  if (bom) out.set([0xef, 0xbb, 0xbf]);
  out.set(body, bom ? 3 : 0);
  return out.buffer;
};

/** The shape ArcGIS Pro wrote for Shinjuku: the style caps the source at 16, the service says 15 to 21. */
const shinjukuStyle = {
  version: 8,
  sprite: "../sprites/sprite",
  glyphs: "../fonts/{fontstack}/{range}.pbf",
  sources: { esri: { type: "vector", minzoom: 16, maxzoom: 16, scheme: "xyz", url: "../../", bounds: [-180, -85.0511, 180, 85.0511] } },
  layers: [
    { id: "背景マスク", type: "fill", source: "esri", "source-layer": "a" },
    { id: "背景地図/新宿駅_道路", type: "fill", source: "esri", "source-layer": "b" },
    { id: "B1/JRShinjukuSta_B1_unit", type: "fill", source: "esri", "source-layer": "c" },
    { id: "MB/B1/JRShinjukuSta_MB_unit", type: "fill", source: "esri", "source-layer": "d", layout: { visibility: "none" } },
    { id: "1F/JRShinjukuSta_1F_unit", type: "line", source: "esri", "source-layer": "e" }
  ]
};
const shinjukuService = { tiles: ["tile/{z}/{y}/{x}.pbf"], minzoom: 15, maxzoom: 21, minLOD: 0, maxLOD: 16 };
const shinjukuIndex: TileIndex = {
  name: "shinjuku_station",
  levels: [
    { z: 0, count: 1, rows: [0, 0], columns: [0, 0] },
    { z: 16, count: 9, rows: [25802, 25804], columns: [58198, 58200] }
  ]
};
const reader = (files: Record<string, unknown>) => async (path: string) => (files[path] as Record<string, unknown>) ?? null;

describe("prepareStyle", () => {
  it("rewrites every URL to the vtiles protocol, resolved inside the folder", async () => {
    const prepared = await prepareStyle(encode(shinjukuStyle), reader({ "root.json": shinjukuService }), shinjukuIndex);

    if (!prepared.ok) throw new Error(prepared.fatal.kind);
    expect(prepared.style.sources.esri).toEqual({
      type: "vector",
      tiles: ["vtiles://tile/{z}/{y}/{x}.pbf"],
      minzoom: 16,
      maxzoom: 16,
      scheme: "xyz",
      bounds: [-180, -85.0511, 180, 85.0511]
    });
    expect(prepared.style.sprite).toBe("vtiles://resources/sprites/sprite");
    expect(prepared.style.glyphs).toBe("vtiles://resources/fonts/{fontstack}/{range}.pbf");
    expect(prepared.primary).toMatchObject({ minzoom: 16, maxzoom: 16, minFrom: "style", maxFrom: "style" });
    expect(prepared.problems).toEqual([]);
  });

  it("takes the zoom range from the service, and says when it reaches past the levels on disk", async () => {
    const style = { ...shinjukuStyle, sources: { esri: { type: "vector", url: "../../" } } };

    const prepared = await prepareStyle(encode(style), reader({ "root.json": shinjukuService }), shinjukuIndex);

    if (!prepared.ok) throw new Error(prepared.fatal.kind);
    expect(prepared.primary).toMatchObject({ minzoom: 15, maxzoom: 21, minFrom: "service", maxFrom: "service" });
    expect(prepared.problems).toEqual([{ kind: "beyond-disk", maxzoom: 21, deepest: 16 }]);
  });

  it("falls back to the levels on disk and Esri's own layout when the service cannot be read", async () => {
    const style = { ...shinjukuStyle, sources: { esri: { type: "vector", url: "../../", minzoom: "16" } } };

    const prepared = await prepareStyle(encode(style, true), reader({}), shinjukuIndex);

    if (!prepared.ok) throw new Error(prepared.fatal.kind);
    expect(prepared.primary).toMatchObject({
      template: "tile/{z}/{y}/{x}.pbf",
      minzoom: 0,
      maxzoom: 16,
      minFrom: "disk",
      maxFrom: "disk"
    });
    expect(prepared.problems).toEqual([
      { kind: "style-bom" },
      { kind: "zoom-not-number", key: "minzoom", value: '"16"' },
      { kind: "service-unreadable", path: "root.json" }
    ]);
  });

  it("frames the map on the deepest level's tiles, not the service's whole-world extent", async () => {
    const prepared = await prepareStyle(encode(shinjukuStyle), reader({ "root.json": shinjukuService }), shinjukuIndex);

    if (!prepared.ok) throw new Error(prepared.fatal.kind);
    const [[west, south], [east, north]] = prepared.frame!;
    expect(west).toBeLessThan(139.7006);
    expect(east).toBeGreaterThan(139.7006);
    expect(south).toBeLessThan(35.6896);
    expect(north).toBeGreaterThan(35.6896);
    expect(east - west).toBeLessThan(0.02);
  });

  it.each([
    [null, "no-style"],
    [new TextEncoder().encode("{ not json").buffer as ArrayBuffer, "style-not-json"],
    [encode({ version: 8, sources: { r: { type: "raster", tiles: ["x"] } }, layers: [] }), "no-vector-source"]
  ])("cannot draw %#", async (bytes, kind) => {
    const prepared = await prepareStyle(bytes, reader({}), shinjukuIndex);

    expect(prepared.ok ? null : prepared.fatal.kind).toBe(kind);
  });
});

describe("paths", () => {
  it.each([
    ["resources/styles/root.json", "../../", ""],
    ["resources/styles/root.json", "../sprites/sprite", "resources/sprites/sprite"],
    ["root.json", "tile/{z}/{y}/{x}.pbf", "tile/{z}/{y}/{x}.pbf"],
    ["resources/styles/root.json", "https://example.com/sprite", "https://example.com/sprite"]
  ])("%s + %s", (base, relative, expected) => {
    expect(resolvePath(base, relative)).toBe(expected);
  });

  it("reads a font stack MapLibre percent-encoded", () => {
    expect(protocolPath("vtiles://resources/fonts/MS%20UI%20Gothic%20Regular/0-255.pbf")).toBe(
      "resources/fonts/MS UI Gothic Regular/0-255.pbf"
    );
  });

  it("finds the .vtiles folder whether it or the folder above it was picked", () => {
    const file = new File([], "x");
    const picked = [
      "full2/shinjuku_station.vtiles/resources/styles/root.json",
      "full2/shinjuku_station.vtiles/tile/16/1/2.pbf",
      "full2/other.txt"
    ];

    const found = folderFiles(picked.map((path) => ({ path, file })));

    expect(found?.name).toBe("shinjuku_station");
    expect([...found!.files.keys()]).toEqual(["resources/styles/root.json", "tile/16/1/2.pbf"]);
    expect(folderFiles([{ path: "a/tile/0/0/0.pbf", file }])).toBeNull();
  });
});

describe("tile levels", () => {
  it("reads Esri's row-before-column layout and ignores everything else", () => {
    expect(
      tileLevels(["tile/16/25802/58198.pbf", "tile/16/25804/58200.pbf", "tile/0/0/0.pbf", "tile/16/x/1.pbf", "tilemap/root.json"])
    ).toEqual([
      { z: 0, count: 1, rows: [0, 0], columns: [0, 0] },
      { z: 16, count: 2, rows: [25802, 25804], columns: [58198, 58200] }
    ]);
    expect(tileBounds([])).toBeNull();
  });
});

describe("groups", () => {
  const groups = groupLayers(shinjukuStyle.layers as never);

  it("groups layers by floor, top first, keeping each layer's own visibility", () => {
    expect(groupOf("MB/B1/JRShinjukuSta_MB_unit")).toBe("MB/B1");
    expect(groupOf("B1/x/y")).toBe("B1");
    expect(groups.map((group) => [group.name, group.background])).toEqual([
      ["1F", false],
      ["MB/B1", false],
      ["B1", false],
      ["背景地図", true],
      ["", true]
    ]);
    expect(groups[1].visibility).toEqual({ "MB/B1/JRShinjukuSta_MB_unit": "none" });
  });

  it("shows one floor with the background, and steps between floors only", () => {
    expect(soloVisibility(groups, "B1")).toEqual({ "1F": false, "MB/B1": false, B1: true, 背景地図: true, "": true });
    expect(stepFloor(groups, null, 1)).toBe("1F");
    expect(stepFloor(groups, "1F", 1)).toBe("MB/B1");
    expect(stepFloor(groups, "B1", 1)).toBe("B1");
    expect(stepFloor(groups, "1F", -1)).toBe("1F");
  });
});

describe("status", () => {
  it("names the level drawn, enlarged past the source's range and nothing below it", () => {
    const source = { minzoom: 15, maxzoom: 16 };
    expect(drawnFrom(14.9, source)).toEqual({ kind: "below", minzoom: 15 });
    expect(drawnFrom(16.5, source)).toEqual({ kind: "level", z: 16 });
    expect(drawnFrom(19.2, source)).toEqual({ kind: "enlarged", z: 16, factor: 8 });
  });

  it("raises the alarm only when every request so far came back missing", () => {
    let stats = emptyTileStats;
    for (let i = 0; i < 12; i++) stats = countTile(stats, `tile/17/${i}/0.pbf`, "missing");
    expect(stats).toMatchObject({ missing: 12, missingByLevel: { 17: 12 }, firstMissing: "tile/17/0/0.pbf" });
    expect(noTilesFound(stats)).toBe(true);
    expect(noTilesFound(countTile(stats, "tile/16/0/0.pbf", "gzip"))).toBe(false);
  });

  it("inflates a gzipped tile and leaves a plain one alone", async () => {
    const plain = new Uint8Array([1, 2, 3]).buffer;
    const gzipped = await new Response(new Response(plain).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

    expect(await inflate(plain)).toEqual({ data: plain, gzip: false });
    const inflated = await inflate(gzipped);
    expect([inflated.gzip, [...new Uint8Array(inflated.data)]]).toEqual([true, [1, 2, 3]]);
  });
});
