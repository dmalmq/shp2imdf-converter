import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { fetchTileJobFile, fetchTileJobIndex } from "../api/client";
import { ApiClientError } from "../api/errors";
import { ToastProvider } from "../components/shared/ToastProvider";
import { AppShell } from "../components/shell/AppShell";
import type { TileMap } from "../components/tileViewer/TileMap";
import { useAppStore } from "../store/useAppStore";
import { TileViewerPage } from "./TileViewerPage";

vi.mock("../api/client", () => ({ fetchTileJobIndex: vi.fn(), fetchTileJobFile: vi.fn() }));

type MapProps = Parameters<typeof TileMap>[0];
const drawn: { props: MapProps | null } = { props: null };
// jsdom has no WebGL; the map stands in as the props it was given.
vi.mock("../components/tileViewer/TileMap", () => ({
  TileMap: (props: MapProps) => {
    drawn.props = props;
    return <div data-testid="tile-viewer-map" />;
  }
}));

const style = {
  version: 8,
  sprite: "../sprites/sprite",
  sources: { esri: { type: "vector", url: "../../" } },
  layers: [
    { id: "背景地図/道路", type: "fill", source: "esri", "source-layer": "a" },
    { id: "B1/unit", type: "fill", source: "esri", "source-layer": "b" },
    { id: "1F/unit", type: "fill", source: "esri", "source-layer": "c" },
    { id: "1F/detail", type: "line", source: "esri", "source-layer": "d" }
  ]
};
const service = { tiles: ["tile/{z}/{y}/{x}.pbf"], minzoom: 15, maxzoom: 21 };
const index = {
  name: "shinjuku_station",
  levels: [{ z: 16, count: 9, rows: [25802, 25804] as [number, number], columns: [58198, 58200] as [number, number] }]
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppShell>
          <Routes>
            <Route path="/color-theme/tiles/:jobId?" element={<TileViewerPage />} />
          </Routes>
        </AppShell>
      </ToastProvider>
    </MemoryRouter>
  );
}

const groupList = () => screen.getByRole("heading", { name: "Floors and groups" }).closest("section")!;
const shown = (name: string) => within(groupList()).getByRole("checkbox", { name: `Show ${name}` });

beforeEach(() => {
  vi.clearAllMocks();
  drawn.props = null;
  useAppStore.setState({ uiLanguage: "en" });
  vi.mocked(fetchTileJobIndex).mockResolvedValue(index);
  vi.mocked(fetchTileJobFile).mockImplementation(async (_job, path) => {
    if (path === "resources/styles/root.json") return bytes(style);
    if (path === "root.json") return bytes(service);
    return null;
  });
});

test("a finished build is read from the server and drawn through the vtiles protocol, floors top first", async () => {
  renderAt("/color-theme/tiles/a1b2c3");

  expect(await screen.findByRole("heading", { name: "shinjuku_station" })).toBeInTheDocument();
  expect(fetchTileJobIndex).toHaveBeenCalledWith("a1b2c3");
  expect(vi.mocked(fetchTileJobFile).mock.calls.map(([job, path]) => [job, path])).toEqual([
    ["a1b2c3", "resources/styles/root.json"],
    ["a1b2c3", "root.json"]
  ]);
  expect(drawn.props?.prepared.style.sources.esri).toMatchObject({ tiles: ["vtiles://tile/{z}/{y}/{x}.pbf"], minzoom: 15, maxzoom: 21 });
  expect(within(groupList()).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["1F2", "B11", "背景地図background1"]);
  expect(screen.getByText("z15–z21")).toBeInTheDocument();
  expect(screen.getByTestId("tile-viewer-problems")).toHaveTextContent(
    "The style allows tiles up to level 21, but the deepest level stored is 16."
  );
});

test("a floor's name shows it alone with the background, and the arrow keys step through floors", async () => {
  renderAt("/color-theme/tiles/a1b2c3");
  await screen.findByRole("heading", { name: "shinjuku_station" });

  fireEvent.click(within(groupList()).getByRole("button", { name: "B1" }));

  expect(drawn.props?.on).toEqual({ "1F": false, B1: true, 背景地図: true });
  fireEvent.keyDown(document, { key: "ArrowUp" });
  expect(drawn.props?.on).toEqual({ "1F": true, B1: false, 背景地図: true });
  expect(shown("1F")).toBeChecked();
  fireEvent.click(within(groupList()).getByRole("button", { name: "All on" }));
  expect(drawn.props?.on).toEqual({ "1F": true, B1: true, 背景地図: true });
});

test("tiles the map reports missing and the features it picks show in the panel", async () => {
  renderAt("/color-theme/tiles/a1b2c3");
  await screen.findByRole("heading", { name: "shinjuku_station" });

  drawn.props!.onStats({ loaded: 0, gzip: 0, missing: 12, failed: 0, missingByLevel: { 17: 12 }, firstMissing: "tile/17/0/0.pbf" });
  drawn.props!.onPick([{ layer: "1F/unit", group: "1F", sourceLayer: "c", geometry: "Polygon", properties: { category: "walkway" } }]);

  await waitFor(() => expect(screen.getByTestId("tile-viewer-problems")).toHaveTextContent("first: tile/17/0/0.pbf"));
  expect(screen.getByText("12 not stored (z17)")).toBeInTheDocument();
  expect(screen.getByTestId("tile-viewer-inspect")).toHaveTextContent("categorywalkway");
});

test("a build the server no longer has says so and offers a folder instead", async () => {
  vi.mocked(fetchTileJobIndex).mockRejectedValue(new ApiClientError(404, "TILE_JOB_NOT_FOUND", "gone"));

  renderAt("/color-theme/tiles/a1b2c3");

  expect(await screen.findByRole("heading", { name: "This build is no longer on the server" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open a .vtiles folder" })).toBeInTheDocument();
  expect(drawn.props).toBeNull();
});

function inFolder(path: string, content: unknown): File {
  const file = new File([JSON.stringify(content)], path.split("/").pop()!);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes(content) });
  return file;
}

test("a folder picked from disk is read where it is, the .vtiles folder found inside the one picked", async () => {
  renderAt("/color-theme/tiles");
  expect(screen.getByRole("heading", { name: "View vector tiles" })).toBeInTheDocument();

  fireEvent.change(screen.getByTestId("tile-viewer-folder-input"), {
    target: {
      files: [
        inFolder("full2/shinjuku_station.vtiles/resources/styles/root.json", style),
        inFolder("full2/shinjuku_station.vtiles/root.json", service),
        inFolder("full2/shinjuku_station.vtiles/tile/16/25803/58199.pbf", {})
      ]
    }
  });

  expect(await screen.findByRole("heading", { name: "shinjuku_station" })).toBeInTheDocument();
  expect(screen.getByText("A .vtiles folder on this computer")).toBeInTheDocument();
  expect(drawn.props?.source.index.levels).toEqual([{ z: 16, count: 1, rows: [25803, 25803], columns: [58199, 58199] }]);
  expect(await drawn.props!.source.read("tile/16/0/0.pbf", new AbortController().signal)).toBeNull();
  expect(fetchTileJobIndex).not.toHaveBeenCalled();
});

test("a folder without a style says which folder to open", async () => {
  renderAt("/color-theme/tiles");

  fireEvent.change(screen.getByTestId("tile-viewer-folder-input"), {
    target: { files: [inFolder("full2/tile/16/1/2.pbf", {})] }
  });

  expect(await screen.findByRole("heading", { name: "These tiles cannot be drawn" })).toBeInTheDocument();
  expect(screen.getByText(/Open the .vtiles folder itself/)).toBeInTheDocument();
});
