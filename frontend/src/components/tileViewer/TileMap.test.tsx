import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CONTEXT_RESTORE_WAIT_MS } from "../../lib/mapHealth";
import type { Prepared, Problem, TileStats, VtilesSource } from "../../lib/vtiles";
import { TileMap } from "./TileMap";

type Protocol = (request: { url: string; type: string }, abort: AbortController) => Promise<unknown>;

const maplibre = vi.hoisted(() => {
  const state = {
    protocol: null as Protocol | null,
    handlers: {} as Record<string, (event: unknown) => void>,
    maps: [] as Array<{ options: Record<string, unknown>; removed: boolean; zoom: number }>
  };
  class FakeMap {
    record: (typeof state.maps)[number];
    constructor(options: Record<string, unknown>) {
      this.record = { options, removed: false, zoom: typeof options.zoom === "number" ? options.zoom : 16 };
      state.maps.push(this.record);
    }
    on(name: string, handler: (event: unknown) => void) {
      state.handlers[name] = handler;
      return this;
    }
    getZoom() {
      return this.record.zoom;
    }
    getCenter() {
      return { lng: 139.7, lat: 35.69 };
    }
    getBearing() {
      return 0;
    }
    getPitch() {
      return 0;
    }
    isStyleLoaded() {
      return false;
    }
    remove() {
      this.record.removed = true;
    }
  }
  const map = new Proxy(FakeMap, {
    construct: (target, args: [Record<string, unknown>]) =>
      new Proxy(new target(...args), { get: (object, key) => (key in object ? Reflect.get(object, key) : () => undefined) })
  });
  return {
    state,
    module: {
      Map: map,
      NavigationControl: class {},
      ScaleControl: class {},
      addProtocol: (_name: string, handler: Protocol) => {
        state.protocol = handler;
      },
      removeProtocol: () => {
        state.protocol = null;
      }
    }
  };
});

vi.mock("maplibre-gl", () => ({ default: maplibre.module, ...maplibre.module }));

const prepared = {
  ok: true,
  style: { version: 8, sources: {}, layers: [] },
  primary: { name: "esri", template: "tile/{z}/{y}/{x}.pbf", minzoom: 15, maxzoom: 16, minFrom: "style", maxFrom: "style" },
  groups: [],
  frame: null,
  problems: []
} as unknown as Extract<Prepared, { ok: true }>;

const source: VtilesSource = { index: { levels: [] } as unknown as VtilesSource["index"], read: async () => null };

beforeEach(() => {
  maplibre.state.protocol = null;
  maplibre.state.handlers = {};
  maplibre.state.maps = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function mount(onStats: (stats: TileStats) => void = () => undefined) {
  const problems: Problem[] = [];
  render(
    <TileMap
      source={source}
      prepared={prepared}
      on={{}}
      showTileBoundaries={false}
      onStats={onStats}
      onZoom={() => undefined}
      onPick={() => undefined}
      onProblem={(problem) => problems.push(problem)}
    />
  );
  return problems;
}

async function request(path: string): Promise<unknown> {
  try {
    await maplibre.state.protocol!({ url: `vtiles://${path}`, type: "arrayBuffer" }, new AbortController());
    return null;
  } catch (error) {
    maplibre.state.handlers.error({ error });
    return error;
  }
}

test("missing glyph ranges are one glyphs-missing problem, not a map error per range", async () => {
  const problems = mount();

  const first = await request("resources/fonts/Arial Regular/0-255.pbf");
  const second = await request("resources/fonts/Arial Regular/12288-12543.pbf");

  expect(first).toBeInstanceOf(Error);
  expect(second).toBeInstanceOf(Error);
  expect(problems).toEqual([{ kind: "glyphs-missing", path: "resources/fonts/Arial Regular/0-255.pbf" }]);
});

test("any other missing file still reaches the problems as a map error", async () => {
  const problems = mount();

  await request("resources/sprites/sprite.json");

  expect(problems).toEqual([{ kind: "map-error", message: "resources/sprites/sprite.json is not in the folder" }]);
});

test("a lost WebGL context remounts one map on the same view, still reading tiles through the vtiles protocol", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  const stats: TileStats[] = [];
  mount((latest) => stats.push(latest));
  await request("tile/16/1/2.pbf");
  act(() => vi.advanceTimersByTime(16));
  maplibre.state.maps[0].zoom = 18.5;

  act(() => maplibre.state.handlers.webglcontextlost(undefined));
  act(() => vi.advanceTimersByTime(CONTEXT_RESTORE_WAIT_MS));

  expect(maplibre.state.maps.map((map) => map.removed)).toEqual([true, false]);
  expect(maplibre.state.maps[1].options).toMatchObject({ center: { lng: 139.7, lat: 35.69 }, zoom: 18.5 });
  expect(maplibre.state.protocol).not.toBeNull();
  await request("tile/16/1/3.pbf");
  act(() => vi.advanceTimersByTime(16));
  expect(stats.at(-1)).toMatchObject({ missing: 2, firstMissing: "tile/16/1/2.pbf" });
});
