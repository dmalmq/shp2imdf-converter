import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import type { Prepared, Problem, VtilesSource } from "../../lib/vtiles";
import { TileMap } from "./TileMap";

type Protocol = (request: { url: string; type: string }, abort: AbortController) => Promise<unknown>;

const maplibre = vi.hoisted(() => {
  const state = { protocol: null as Protocol | null, handlers: {} as Record<string, (event: unknown) => void> };
  class FakeMap {
    on(name: string, handler: (event: unknown) => void) {
      state.handlers[name] = handler;
      return this;
    }
    getZoom() {
      return 16;
    }
    isStyleLoaded() {
      return false;
    }
  }
  const map = new Proxy(FakeMap, {
    construct: (target) =>
      new Proxy(new target(), { get: (object, key) => (key in object ? Reflect.get(object, key) : () => undefined) })
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
      removeProtocol: () => undefined
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
});

function mount() {
  const problems: Problem[] = [];
  render(
    <TileMap
      source={source}
      prepared={prepared}
      on={{}}
      showTileBoundaries={false}
      onStats={() => undefined}
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
