import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  convertColorTheme,
  fetchColorTheme,
  fetchTileJob,
  fetchVectorTilesAvailability,
  inspectColorTheme,
  startTileBuild,
  type ColorThemeInspection,
  type VectorTilesAvailability
} from "../api/client";
import { ApiClientError } from "../api/errors";
import { ToastProvider } from "../components/shared/ToastProvider";
import { AppShell } from "../components/shell/AppShell";
import {
  colorThemeReport,
  colorThemeRules,
  counts,
  layerFilesInspection,
  layerFilesRerunInspection,
  rerunInspection,
  shinjukuGeodatabaseInspection,
  shinjukuProjectInspection,
  shinjukuTileMaps,
  shinjukuShapefileInspection,
  styleFilesFor,
  TOKYO_GDB,
  tokyoGeodatabaseInspection,
  tokyoInspection,
  tokyoStyledInspection
} from "../lib/colorTheme.fixtures";
import { useAppStore } from "../store/useAppStore";
import { ColorThemePage } from "./ColorThemePage";

vi.mock("../api/client", () => ({
  convertColorTheme: vi.fn(),
  fetchColorTheme: vi.fn(),
  fetchTileJob: vi.fn(),
  fetchVectorTilesAvailability: vi.fn(),
  inspectColorTheme: vi.fn(),
  startTileBuild: vi.fn(),
  tileJobDownloadUrl: (jobId: string) => `/api/color-theme/jobs/${jobId}/download`
}));

const NOT_LICENSED: VectorTilesAvailability = {
  state: "unavailable",
  reason: "not_licensed",
  detail: "import arcpy failed: RuntimeError: The Product License has not been initialized."
};
const LICENSED: VectorTilesAvailability = { state: "available", product: "ArcInfo" };

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/color-theme"]}>
      <ToastProvider>
        <AppShell>
          <ColorThemePage />
        </AppShell>
      </ToastProvider>
    </MemoryRouter>
  );
}

function inFolder(name: string, folder = "JRTokyoSta_6677.shp"): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "webkitRelativePath", { value: `${folder}/${name}` });
  return file;
}

function pickFolder(files: File[]) {
  fireEvent.change(screen.getByTestId("color-theme-folder-input"), { target: { files } });
}

const table = () => screen.getByRole("table", { name: "How color2 changes" });
const ruleRow = (text: string) =>
  within(table())
    .getAllByRole("row")
    .find((row) => within(row).queryByRole("rowheader")?.textContent === text);

let saved: string[] = [];
let followed: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ uiLanguage: "en" });
  vi.mocked(fetchColorTheme).mockResolvedValue(colorThemeReport());
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoInspection());
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(NOT_LICENSED);
  saved = [];
  followed = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
    followed.push(this.getAttribute("href") ?? "");
  });
  URL.createObjectURL = vi.fn(() => "blob:new-colors");
  URL.revokeObjectURL = vi.fn();
});

test("shows the whole mapping before anything is uploaded", async () => {
  renderPage();
  await screen.findByRole("table", { name: "How color2 changes" });

  expect(within(table()).getAllByRole("row")).toHaveLength(1 + 15);
  expect(ruleRow("白")).toHaveTextContent("Stairs and escalators");
  expect(ruleRow("白")).toHaveTextContent("階段・エスカレーター");
  expect(ruleRow("濃鼠 · B007–B014")).toHaveTextContent("Facilities");
  expect(within(table()).queryByRole("columnheader", { name: "Rows" })).toBeNull();
  expect(within(table()).getByRole("columnheader", { name: "New area, written to color2" })).toBeInTheDocument();
  expect(within(table()).queryByRole("columnheader", { name: "Written to color2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

test("the category table is shown before anything is uploaded, an area and its categories to a row", async () => {
  renderPage();
  const categories = await screen.findByRole("table", { name: "How layers coloured by category are redrawn" });

  const rows = within(categories).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
    "改札外通路Free area outside the gates · Mono 000",
    "在来線改札内Paid area, conventional lines · PaleBlue 050",
    "施設Facilities · Turquoise 150",
    "進入制限エリアRestricted area · Mono 050",
    "階段・エスカレーターStairs and escalators · Mono 000"
  ]);
  expect(within(rows[0]).getByRole("cell")).toHaveTextContent("walkway, ramp, road");
  expect(within(rows[4]).getByRole("cell")).toHaveTextContent("stairs, escalator, opentobelow");
  expect(categories).not.toHaveTextContent("vegetation");
});

test("in Japanese each rule names its new area once, as the value written", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  renderPage();
  const japaneseTable = await screen.findByRole("table", { name: "color2 の変更内容" });
  const row = within(japaneseTable)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByRole("rowheader")?.textContent === "白");
  expect(row?.textContent?.split("階段・エスカレーター")).toHaveLength(2);
  expect(row).toHaveTextContent("Mono 000");
  expect(within(japaneseTable).getByRole("columnheader", { name: "新エリア（color2 に書く値）" })).toBeInTheDocument();
});

test("a picked folder is sent with its layout and checked rule by rule", async () => {
  renderPage();
  await screen.findByRole("table", { name: "How color2 changes" });
  expect((screen.getByTestId("color-theme-folder-input") as HTMLInputElement).webkitdirectory).toBe(true);

  pickFolder([inFolder("JRTokyoSta_1_Space.dbf"), inFolder("acad.err")]);

  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_6677" });
  const sent = vi.mocked(inspectColorTheme).mock.calls[0][0];
  expect(sent.map((file) => file.path)).toEqual(["JRTokyoSta_6677.shp/JRTokyoSta_1_Space.dbf", "JRTokyoSta_6677.shp/acad.err"]);

  expect(within(table()).getByRole("columnheader", { name: "Rows" })).toBeInTheDocument();
  expect(ruleRow("白")).toHaveTextContent("711");
  expect(ruleRow("薄鼠")).toHaveTextContent("612");
  expect(ruleRow("濃鼠 · B007–B014")).toHaveTextContent(/0$/);

  const summary = screen.getByRole("region", { name: "What this station gets" });
  expect(summary).toHaveTextContent("Changes2,164");
  expect(summary).toHaveTextContent("Left as is0");
  expect(summary).toHaveTextContent("Files back untouched491 / 501");

  expect(screen.getByRole("heading", { name: "Nothing needs attention" })).toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("JRTokyoSta_6677")).toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Stages" })).getByText("2 · Check")).toBeInTheDocument();
});

test("layer files and projects are listed layer by layer, with what was left alone, and can be downloaded", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(layerFilesInspection());
  renderPage();
  await screen.findByRole("table", { name: "How color2 changes" });
  expect((screen.getByTestId("color-theme-zip-input") as HTMLInputElement).accept).toBe(".zip,.lyrx,.aprx");

  pickFolder(
    ["DemoSta_0_Space.lyrx", "DemoSta.aprx", "DemoSta_units.aprx"].map((name) => inFolder(name, "DemoSta_layers"))
  );

  await screen.findByRole("heading", { level: 1, name: "Recolour DemoSta_layers" });
  expect(within(table()).queryByRole("columnheader", { name: "Rows" })).toBeNull();
  const symbology = screen.getByRole("region", { name: "Symbology" });
  expect(symbology).toHaveTextContent("DemoSta_layers/DemoSta_0_Space.lyrxLayer file1 redrawn");
  expect(symbology).toHaveTextContent("DemoSta_layers/DemoSta.aprxProject2 redrawn · 1 left as is");
  expect(symbology).toHaveTextContent("Esri does not document editing a project outside ArcGIS Pro. Keep the original");
  const row = (layer: string, index = 0) => within(symbology).getAllByText(layer)[index].closest("tr") as HTMLElement;
  expect(Array.from(row("DemoSta_1_Space").children, (cell) => cell.textContent)).toEqual([
    "DemoSta_1_Space",
    "color2",
    "15 → 7",
    "",
    "RedrawnKept as it was: 赤"
  ]);
  expect(symbology).toHaveTextContent("DemoSta_layers/DemoSta_units.aprxProject2 redrawn");
  expect(Array.from(row("DemoSta_1_unit").children, (cell) => cell.textContent)).toEqual([
    "DemoSta_1_unit",
    "category",
    "30 → 6",
    "",
    "RedrawnKept as it was: vegetation"
  ]);
  expect(within(row("DemoSta_1_unit")).getAllByTitle(/·/).map((swatch) => swatch.title)).toEqual([
    "改札外通路 · Mono 000",
    "在来線改札内 · PaleBlue 050",
    "施設 · Turquoise 150",
    "進入制限エリア · Mono 050",
    "階段・エスカレーター · Mono 000"
  ]);
  expect(within(row("DemoSta_1_Space")).getAllByTitle(/·/).map((swatch) => swatch.title)).toEqual([
    "改札外通路 · Mono 000",
    "在来線改札内 · PaleBlue 050",
    "新幹線改札内 · PaleBlue 100",
    "施設 · Turquoise 150",
    "進入制限エリア · Mono 050",
    "階段・エスカレーター · Mono 000"
  ]);
  expect(row("DemoSta_B1_Space")).toHaveTextContent("Coloured by an Arcade expression on color2; left as it is");

  const attention = screen.getByRole("region", { name: "Needs attention" });
  expect(attention).toHaveTextContent("DemoSta_B1_SpaceDemoSta.aprx · Coloured by an Arcade expression on color2; left as it is");
  expect(attention).toHaveTextContent("DemoSta_1_SpaceDemoSta.aprx · not in the table, kept in its old class: 赤");
  expect(attention).toHaveTextContent("2 layersDemoSta_units.aprx · not in the table, kept in their old classes: vegetation");
  expect(within(attention).getAllByRole("listitem")).toHaveLength(3);

  const summary = screen.getByRole("region", { name: "What this station gets" });
  expect(summary).toHaveTextContent("Layers redrawn5");
  expect(summary).toHaveTextContent("Files back untouched0 / 3");
  expect(summary).not.toHaveTextContent(/No layer here has a color2 field/);
  const returns = screen.getByRole("region", { name: "What comes back" });
  expect(returns).toHaveTextContent(/Layer files \(\.lyrx\) and projects \(\.aprx\) come back with each layer coloured by color2 redrawn/);
  expect(returns).toHaveTextContent("an old 濃鼠 toilet (B007–B014) draws white until its data is converted");
  expect(returns).toHaveTextContent(/A layer coloured by category alone, in a station with no color2, is redrawn too/);
  expect(returns).not.toHaveTextContent(/Shapefiles come back/);
  const next = screen.getByRole("region", { name: "Next step" });
  expect(next).toHaveTextContent("5 layers are redrawn");
  expect(within(next).getByRole("button", { name: "Download" })).toBeEnabled();
});

test("a project drawn by category reads as category layers: one line for the 58 that keep vegetation, and no color2 promise", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  renderPage();
  pickFolder([new File(["x"], "shinjuku.aprx")]);

  await screen.findByRole("heading", { level: 1, name: "Recolour shinjuku" });
  const symbology = screen.getByRole("region", { name: "Symbology" });
  expect(symbology).toHaveTextContent("shinjuku.aprxProject58 redrawn");
  expect(within(symbology).getAllByRole("cell", { name: "category" })).toHaveLength(58);
  expect(within(symbology).queryByRole("cell", { name: "color2" })).toBeNull();
  const attention = screen.getByRole("region", { name: "Needs attention" });
  expect(within(attention).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "58 layersshinjuku.aprx · not in the table, kept in their old classes: vegetation"
  ]);
  const returns = screen.getByRole("region", { name: "What comes back" });
  expect(returns).toHaveTextContent(
    "one class per new area its categories belong to, in the same fills and outline. Its data is not changed. A category that is not in the table keeps its own class and colour."
  );
  expect(returns).not.toHaveTextContent(/coloured by color2 redrawn/);
  expect(returns).not.toHaveTextContent(/濃鼠/);
  expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("58 layers are redrawn");
});

test("a station with no color2 says so in the summary, and one drawn by category is told to drop its layer file or project", async () => {
  const summary = () => screen.getByRole("region", { name: "What this station gets" });
  const drawnByCategory =
    "No layer here has a color2 field. This station is coloured by category in its layer file or project, so drop its .lyrx or .aprx to recolour it.";
  const shinjuku = shinjukuGeodatabaseInspection();
  vi.mocked(inspectColorTheme)
    .mockResolvedValueOnce(shinjuku)
    .mockResolvedValueOnce({ ...shinjuku, dataset: { ...shinjuku.dataset, name: "Plain", category_only_tables: 0 } })
    .mockResolvedValueOnce(tokyoInspection());
  renderPage();

  pickFolder([inFolder("a00000001.gdbtable", "JRShinjukuSta.gdb")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRShinjukuSta" });
  expect(summary()).toHaveTextContent("Changes0Layers0Left as is0Geodatabases1");
  expect(summary()).toHaveTextContent(drawnByCategory);
  expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("Nothing to changeNo layer has a color2 field.");
  expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();

  pickFolder([inFolder("a00000001.gdbtable", "Plain.gdb")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour Plain" });
  expect(summary()).toHaveTextContent("No layer here has a color2 field, so there is nothing to rewrite.");
  expect(summary()).not.toHaveTextContent(/coloured by category/);

  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_6677" });
  expect(summary()).not.toHaveTextContent(/No layer here has a color2 field/);
});

test("in Japanese a station drawn by category is told the same in two sentences", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuGeodatabaseInspection());
  renderPage();
  pickFolder([inFolder("a00000001.gdbtable", "JRShinjukuSta.gdb")]);

  await screen.findByRole("heading", { level: 1, name: "JRShinjukuSta の色を新しくする" });
  expect(screen.getByRole("region", { name: "この駅の変更内容" })).toHaveTextContent(
    "color2 フィールドのあるレイヤーがありません。この駅はレイヤーファイルまたはプロジェクトで category により色分けされているため、.lyrx か .aprx をドロップして色を新しくしてください。"
  );
});

test("layer files run a second time have nothing to download", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(layerFilesRerunInspection());
  renderPage();
  pickFolder([inFolder("DemoSta.aprx", "DemoSta_layers")]);

  await screen.findByRole("heading", { level: 1, name: "Recolour DemoSta_layers" });
  expect(screen.getByRole("region", { name: "Symbology" })).toHaveTextContent("Already new");
  expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("Nothing to change");
  expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
});

test("a drop sends every file, whatever its kind", async () => {
  renderPage();
  const files = ["JRTokyoSta_1_Space.dbf", "JRTokyoSta_1_Space.sbn", "JRTokyoSta_1_Space.shp.xml", "acad.err"].map(
    (name) => new File(["x"], name)
  );
  fireEvent.change(screen.getByTestId("color-theme-drop-input"), { target: { files } });
  await waitFor(() => expect(inspectColorTheme).toHaveBeenCalledTimes(1));
  expect(vi.mocked(inspectColorTheme).mock.calls[0][0].map(({ file }) => file)).toEqual(files);
});

test("everything left as it is is listed under Needs attention, with why", async () => {
  const tokyo = tokyoInspection();
  const rules = colorThemeRules({ 白: 711 }).map((rule) => (rule.old === "トイレ" ? { ...rule, too_wide: 3 } : rule));
  const [first, second, ...rest] = tokyo.theme.layers;
  const inspection: ColorThemeInspection = {
    ...tokyo,
    theme: {
      ...tokyo.theme,
      rules,
      unmapped: [{ value: "赤", rows: 12, layers: ["JRTokyoSta_6677.shp/JRTokyoSta_1_Space.dbf", "JRTokyoSta_6677.shp/JRTokyoSta_2_Space.dbf"] }],
      layers: [
        { ...first, encoding: { codec: "cp932", source: "sniffed" }, counts: counts({ ...first.counts, undecodable: 2 }) },
        { ...second, width: 24, counts: counts({ ...second.counts, too_wide: 3 }) },
        ...rest
      ],
      skipped: [{ id: "JRTokyoSta_6677.shp/JRTokyoSta_9_Space.dbf", reason: "field_not_text" }],
      totals: counts({ rows: 2181, recolor: 2164, unmapped: 12, too_wide: 3, undecodable: 2 })
    }
  };
  vi.mocked(inspectColorTheme).mockResolvedValue(inspection);
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);

  const attention = await screen.findByRole("region", { name: "Needs attention" });
  expect(attention).toHaveTextContent("赤12 rows in 2 layers · not in the table, left as is");
  expect(within(attention).getByTitle("JRTokyoSta_6677.shp/JRTokyoSta_2_Space.dbf")).toHaveTextContent("JRTokyoSta_2_Space.dbf");
  expect(attention).toHaveTextContent("JRTokyoSta_1_Space.dbf3 rows · the new value does not fit color2 (24 bytes), left as is");
  expect(ruleRow("トイレ")).toHaveTextContent("3 left as is");
  expect(attention).toHaveTextContent("JRTokyoSta_0_Space.dbf2 rows could not be read as cp932, left as is");
  expect(attention).toHaveTextContent("JRTokyoSta_9_Space.dbfcolor2 is not a text field; the file comes back untouched");
  expect(screen.getByRole("region", { name: "What this station gets" })).toHaveTextContent("Left as is17");

  fireEvent.click(screen.getByText("Layers (10)"));
  const layerRow = (id: string) => screen.getByText(id).closest("tr");
  const layerTable = layerRow("JRTokyoSta_6677.shp/JRTokyoSta_0_Space.dbf")?.closest("table") as HTMLElement;
  expect(within(layerTable).getByRole("columnheader", { name: "Left as is" })).toBeInTheDocument();
  expect(layerRow("JRTokyoSta_6677.shp/JRTokyoSta_0_Space.dbf")?.lastElementChild).toHaveTextContent(/^2$/);
  expect(layerRow("JRTokyoSta_6677.shp/JRTokyoSta_1_Space.dbf")?.lastElementChild).toHaveTextContent(/^3$/);
  expect(layerRow("JRTokyoSta_6677.shp/JRTokyoSta_2_Space.dbf")?.lastElementChild).toHaveTextContent(/^0$/);
});

test("a geodatabase field's width reads in characters, and 0 as no limit, where a shapefile's reads in bytes", async () => {
  const shapefiles = tokyoInspection();
  const [narrow, ...rest] = tokyoGeodatabaseInspection().theme.layers;
  vi.mocked(inspectColorTheme).mockResolvedValue({
    dataset: { ...shapefiles.dataset, geodatabases: 1 },
    theme: {
      ...shapefiles.theme,
      layers: [shapefiles.theme.layers[0], { ...narrow, counts: counts({ ...narrow.counts, too_wide: 4 }) }, ...rest]
    }
  });
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);

  const attention = await screen.findByRole("region", { name: "Needs attention" });
  expect(attention).toHaveTextContent("JRTokyoSta_1_Space4 rows · the new value does not fit color2 (12 characters), left as is");

  fireEvent.click(screen.getByText("Layers (5)"));
  const cells = (id: string) => Array.from((screen.getByText(id).closest("tr") as HTMLElement).children, (cell) => cell.textContent);
  expect(cells(`${TOKYO_GDB}/JRTokyoSta_1_Space`).slice(1, 3)).toEqual(["utf-8 · geodatabase", "12 characters"]);
  expect(cells(`${TOKYO_GDB}/JRTokyoSta_B1_Space`).slice(1, 3)).toEqual(["utf-8 · geodatabase", "no limit"]);
  expect(cells("JRTokyoSta_6677.shp/JRTokyoSta_0_Space.dbf").slice(1, 3)).toEqual(["utf-8 · .cpg", "254 bytes"]);
});

test("a geodatabase this server cannot edit or read is listed under Needs attention, and Download says nothing can be edited", async () => {
  const gdb = tokyoGeodatabaseInspection();
  const skipped = [
    { id: TOKYO_GDB, reason: "gdb_unavailable" as const },
    { id: "JRShinjukuSta.gdb", reason: "unreadable" as const }
  ];
  vi.mocked(inspectColorTheme).mockResolvedValue({
    ...gdb,
    dataset: { ...gdb.dataset, geodatabases: 2 },
    theme: { ...gdb.theme, rules: colorThemeRules(), layers: [], skipped, totals: counts() }
  });
  renderPage();
  pickFolder([inFolder("a00000001.gdbtable", TOKYO_GDB)]);

  const attention = await screen.findByRole("region", { name: "Needs attention" });
  expect(within(attention).getByTitle(TOKYO_GDB)).toHaveTextContent(/^JRTokyoSta_3857\.gdb$/);
  expect(attention).toHaveTextContent(
    "JRTokyoSta_3857.gdbThis server has no Python with GDAL (ArcGIS Pro’s, or the one GDB_GDAL_PYTHON names), so the geodatabase cannot be edited; it comes back as uploaded"
  );
  expect(attention).toHaveTextContent("JRShinjukuSta.gdbThe geodatabase could not be read safely; it comes back untouched");
  expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("No color2 field here can be edited.");
  expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
});

test("the geodatabase paragraph appears only for an upload holding one, and the byte-for-byte promise only where shapefiles come back", async () => {
  const byteForByte = /Shapefiles come back.*byte for byte/;
  const rewritten = /In a geodatabase, GDAL rewrites each changed row.*Convert a copy and open it in ArcGIS Pro/;
  const returns = () => screen.getByRole("region", { name: "What comes back" });
  const shapefiles = tokyoInspection();
  const gdb = tokyoGeodatabaseInspection();
  vi.mocked(inspectColorTheme)
    .mockResolvedValueOnce(shapefiles)
    .mockResolvedValueOnce(gdb)
    .mockResolvedValueOnce({
      dataset: { ...gdb.dataset, name: "JRTokyoSta" },
      theme: { ...gdb.theme, layers: [...shapefiles.theme.layers, ...gdb.theme.layers] }
    });
  renderPage();
  await screen.findByRole("table", { name: "How color2 changes" });
  expect(returns()).toHaveTextContent(byteForByte);
  expect(returns()).toHaveTextContent(rewritten);

  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_6677" });
  expect(returns()).toHaveTextContent(byteForByte);
  expect(returns()).not.toHaveTextContent(/geodatabase/);

  pickFolder([inFolder("a00000001.gdbtable", TOKYO_GDB)]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_3857" });
  expect(returns()).toHaveTextContent(rewritten);
  expect(returns()).not.toHaveTextContent(/byte for byte/);

  pickFolder([inFolder("a00000001.gdbtable", TOKYO_GDB), inFolder("JRTokyoSta_1_Space.dbf")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta" });
  expect(returns()).toHaveTextContent(byteForByte);
  expect(returns()).toHaveTextContent(rewritten);
});

test("stale lock files are counted once, the page's and the server's together, and not mentioned when there are none", async () => {
  const gdb = tokyoGeodatabaseInspection();
  vi.mocked(inspectColorTheme)
    .mockResolvedValueOnce({ ...gdb, dataset: { ...gdb.dataset, lock_files_dropped: 1055 } })
    .mockResolvedValueOnce(tokyoInspection());
  const returns = () => screen.getByRole("region", { name: "What comes back" });
  renderPage();
  pickFolder([
    inFolder("a00000004.gdbtable", TOKYO_GDB),
    inFolder("_gdb.TOKYO-PC.10424.12388.sr.lock", TOKYO_GDB),
    inFolder("a00000004.TOKYO-PC.10424.12388.sr.lock", TOKYO_GDB)
  ]);

  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_3857" });
  expect(vi.mocked(inspectColorTheme).mock.calls[0][0].map(({ path }) => path)).toEqual([`${TOKYO_GDB}/a00000004.gdbtable`]);
  expect(returns()).toHaveTextContent("Left out: 1,057 stale geodatabase lock files.");

  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_6677" });
  expect(returns()).not.toHaveTextContent(/lock file/);
});

test("Files back untouched is not claimed for an upload holding a geodatabase", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoGeodatabaseInspection());
  renderPage();
  pickFolder([inFolder("a00000001.gdbtable", TOKYO_GDB)]);

  const summary = await screen.findByRole("region", { name: "What this station gets" });
  expect(summary).toHaveTextContent("Changes5,996");
  expect(summary).toHaveTextContent("Geodatabases1");
  expect(summary).not.toHaveTextContent("Files back untouched");
});

test("the Next step bar promises an exact copy for shapefiles only, since GDAL rewrites a geodatabase's changed rows", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValueOnce(tokyoInspection()).mockResolvedValueOnce(tokyoGeodatabaseInspection());
  renderPage();
  const bar = () => screen.getByRole("region", { name: "Next step" });

  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_6677" });
  expect(bar()).toHaveTextContent("Everything else comes back exactly as it was.");

  pickFolder([inFolder("a00000001.gdbtable", TOKYO_GDB)]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_3857" });
  expect(bar()).toHaveTextContent("Everything but the changed rows comes back as it was.");
  expect(bar()).not.toHaveTextContent("exactly");
});

test("on a station already converted, Download is disabled and says why", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(rerunInspection());
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf", "JRTokyoSta_6677_new-colors")]);

  const download = await screen.findByRole("button", { name: "Download" });
  expect(download).toBeDisabled();
  const bar = screen.getByRole("region", { name: "Next step" });
  expect(bar).toHaveTextContent("Nothing to change");
  expect(bar).toHaveTextContent("Every value is already new.");
  expect(bar.textContent?.split("Nothing to change")).toHaveLength(2);
  fireEvent.click(download);
  expect(convertColorTheme).not.toHaveBeenCalled();
});

test("Download sends the same files again and saves the zip under the server's name", async () => {
  vi.mocked(convertColorTheme).mockResolvedValue({ blob: new Blob(["zip"]), filename: "JRTokyoSta_6677_new-colors.zip" });
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf"), inFolder("JRTokyoSta_1_Space.shp")]);

  const bar = await screen.findByRole("region", { name: "Next step" });
  expect(bar).toHaveTextContent("2,164 values change in 10 layers");
  expect(bar).toHaveTextContent("JRTokyoSta_6677_new-colors.zip");
  fireEvent.click(within(bar).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(saved).toEqual(["JRTokyoSta_6677_new-colors.zip"]));
  const inspected = vi.mocked(inspectColorTheme).mock.calls[0][0];
  expect(vi.mocked(convertColorTheme).mock.calls[0][0]).toBe(inspected);
  expect(await screen.findByText("Created JRTokyoSta_6677_new-colors.zip")).toBeInTheDocument();
  expect(bar).toHaveTextContent("Downloaded JRTokyoSta_6677_new-colors.zip");
  expect(bar.textContent?.split("JRTokyoSta_6677_new-colors.zip")).toHaveLength(2);
  expect(within(screen.getByRole("navigation", { name: "Stages" })).getByText("3 · Deliver")).toBeInTheDocument();
});

test("a new drop aborts the check in flight, and its late answer is ignored", async () => {
  const answers: Array<(inspection: ColorThemeInspection) => void> = [];
  vi.mocked(inspectColorTheme).mockImplementation(
    () => new Promise((resolve) => answers.push(resolve))
  );
  renderPage();
  pickFolder([inFolder("JRShinjukuSta_1_Space.dbf", "JRShinjukuSta.shp")]);
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  await waitFor(() => expect(answers).toHaveLength(2));

  const [first, second] = vi.mocked(inspectColorTheme).mock.calls.map(([, options]) => options.signal as AbortSignal);
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);

  const shinjuku = tokyoInspection();
  await act(async () => answers[0]({ ...shinjuku, dataset: { ...shinjuku.dataset, name: "JRShinjukuSta" } }));
  expect(screen.getByRole("status")).toHaveTextContent("Sending 1 file");
  await act(async () => answers[1](tokyoInspection()));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Recolour JRTokyoSta_6677");
});

test("a failed check says why beside the drop area", async () => {
  vi.mocked(inspectColorTheme).mockRejectedValue(
    Object.assign(new Error("Upload exceeds 200 MB"), { name: "ApiClientError", detail: "Upload exceeds 200 MB" })
  );
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  expect(await screen.findByRole("alert")).toHaveTextContent("Upload exceeds 200 MB");
  expect(screen.getByRole("button", { name: "Choose folder" })).toBeInTheDocument();
});


const styleOption = () => screen.getByRole("checkbox", { name: /Add style files for QGIS and ArcGIS Pro/ });

test("style files are on by default: the page counts them, lists their layers, and Download asks for them", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoStyledInspection());
  vi.mocked(convertColorTheme).mockResolvedValue({ blob: new Blob(["zip"]), filename: "JRTokyoSta_6677_new-colors.zip" });
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf"), inFolder("JRTokyoSta_1_Space.shp")]);

  const bar = await screen.findByRole("region", { name: "Next step" });
  expect(styleOption()).toBeChecked();
  expect(bar).toHaveTextContent("2,164 values change in 10 layers · 20 style files are added");
  expect(screen.getByRole("region", { name: "What this station gets" })).toHaveTextContent("Style files added20");
  const section = screen.getByRole("region", { name: "Style files" });
  expect(section).toHaveTextContent("20 files beside 10 polygon layers");
  expect(within(section).getAllByRole("row")[1]).toHaveTextContent("JRTokyoSta_6677.shp/JRTokyoSta_0_Space.shpcolor2.qml · .lyrx");
  expect(within(within(section).getAllByRole("row")[1]).getAllByTitle(/ · /)).toHaveLength(6);

  fireEvent.click(within(bar).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(saved).toEqual(["JRTokyoSta_6677_new-colors.zip"]));
  expect(vi.mocked(convertColorTheme).mock.calls[0][1]).toMatchObject({ styleFiles: true });
});

test("with style files switched off the page promises none and Download asks for none", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoStyledInspection());
  vi.mocked(convertColorTheme).mockResolvedValue({ blob: new Blob(["zip"]), filename: "JRTokyoSta_6677_new-colors.zip" });
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  const bar = await screen.findByRole("region", { name: "Next step" });

  fireEvent.click(styleOption());

  expect(styleOption()).not.toBeChecked();
  expect(bar).toHaveTextContent("2,164 values change in 10 layers");
  expect(bar).not.toHaveTextContent(/style file/);
  expect(screen.getByRole("region", { name: "What this station gets" })).not.toHaveTextContent(/Style files added/);
  fireEvent.click(within(bar).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(vi.mocked(convertColorTheme).mock.calls[0][1]).toMatchObject({ styleFiles: false });
});

test("a shapefile station drawn by category can be downloaded for its style files, and not once they are switched off", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuShapefileInspection());
  renderPage();
  pickFolder([inFolder("JRShinjukuSta_1_unit.dbf", "JRShinjukuSta_6677")]);

  const bar = await screen.findByRole("region", { name: "Next step" });
  expect(bar).toHaveTextContent("4 style files are added");
  expect(within(bar).getByRole("button", { name: "Download" })).toBeEnabled();
  expect(screen.getByRole("region", { name: "What this station gets" })).toHaveTextContent(
    "drop its .lyrx or .aprx to recolour it. The style files below still draw 2 polygon layers in the new colours."
  );
  const rows = within(screen.getByRole("region", { name: "Style files" })).getAllByRole("row");
  expect(rows[1]).toHaveTextContent("JRShinjukuSta_1_unit.shpcategory.qml · .lyrx");
  expect(within(rows[1]).getAllByTitle(/ · /)).toHaveLength(5);

  fireEvent.click(styleOption());

  expect(bar).toHaveTextContent("Nothing to changeNo layer has a color2 field.");
  expect(within(bar).getByRole("button", { name: "Download" })).toBeDisabled();
  expect(screen.getByRole("region", { name: "What this station gets" })).not.toHaveTextContent(/style files below/);
});

test("a style file the upload already has is shown as kept, and the option is off limits when none is left to add", async () => {
  const [qml, lyrx] = styleFilesFor("st/1_Space.shp");
  const mine = { ...qml, path: "st/1_SPACE.QML", outcome: "kept" as const };
  const tokyo = tokyoInspection();
  vi.mocked(inspectColorTheme)
    .mockResolvedValueOnce({ ...tokyo, theme: { ...tokyo.theme, style_files: [mine, lyrx] } })
    .mockResolvedValueOnce({
      ...tokyo,
      dataset: { ...tokyo.dataset, name: "Again" },
      theme: { ...tokyo.theme, style_files: [mine, { ...lyrx, outcome: "kept" }] }
    });
  renderPage();

  pickFolder([inFolder("1_Space.dbf", "st")]);
  const section = await screen.findByRole("region", { name: "Style files" });
  expect(section).toHaveTextContent("1 file beside 1 polygon layer");
  expect(within(section).getAllByRole("row")[1]).toHaveTextContent(".lyrxAlready here, kept as it is: 1_SPACE.QML");

  pickFolder([inFolder("1_Space.dbf", "Again")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour Again" });
  expect(screen.getByRole("region", { name: "Style files" })).toHaveTextContent("Every layer here already has both style files");
  expect(styleOption()).toBeDisabled();
  expect(screen.getByRole("region", { name: "Next step" })).not.toHaveTextContent(/style file/);
});

test("the page says plainly that ArcGIS Pro drawing the layer file is unverified, before an upload and beside the option", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoStyledInspection());
  renderPage();
  const returns = await screen.findByRole("region", { name: "What comes back" });
  expect(returns).toHaveTextContent("ArcGIS Pro drawing the .lyrx has not been verified.");

  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);

  const section = await screen.findByRole("region", { name: "Style files" });
  expect(section).toHaveTextContent("ArcGIS Pro drawing the .lyrx has not been verified, so open one in Pro before you rely on it.");
});

test("a geodatabase, which gets no style files, shows neither the option nor its paragraph", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoGeodatabaseInspection());
  renderPage();
  pickFolder([inFolder("a00000001.gdbtable", TOKYO_GDB)]);

  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_3857" });
  expect(screen.queryByRole("region", { name: "Style files" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "What comes back" })).not.toHaveTextContent(/style files/);
});

test("in Japanese the option and its count read in the page's idiom", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoStyledInspection());
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);

  expect(await screen.findByRole("checkbox", { name: /QGIS と ArcGIS Pro 用のスタイルファイルを追加/ })).toBeChecked();
  expect(screen.getByRole("region", { name: "次のステップ" })).toHaveTextContent("スタイルファイル 20 個を追加します");
  expect(screen.getByRole("region", { name: "スタイルファイル" })).toHaveTextContent("ArcGIS Pro で .lyrx が正しく描かれるかは未確認");
});

const tilesOption = () => screen.getByRole("checkbox", { name: /Build vector tiles for Stenavi/ });
const tilesRegion = () => screen.getByRole("region", { name: "Vector tiles" });
const layersDialog = () => screen.getByRole("dialog", { name: "Layers to tile" });
const layerBox = (name: string) => within(layersDialog()).getByRole("checkbox", { name });

/** Tick the option, which opens the layer list, and keep what it starts with. */
async function tickTilesKeepingDefaults() {
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Use these layers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

test("vector tiles are off and greyed out, with the reason, when the server's ArcGIS Pro is not licensed", async () => {
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);

  await screen.findByRole("heading", { level: 1, name: "Recolour shinjuku" });
  await waitFor(() =>
    expect(tilesRegion()).toHaveTextContent("ArcGIS Pro is not licensed for the account that runs this server")
  );
  expect(tilesOption()).toBeDisabled();
  expect(tilesOption()).not.toBeChecked();
  expect(tilesRegion()).toHaveTextContent("Only the layers ticked in the layer list are tiled");
});

test("vector tiles are greyed out for an upload with no project or with two", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  renderPage();
  pickFolder([inFolder("JRTokyoSta_1_Space.dbf")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour JRTokyoSta_6677" });
  await waitFor(() => expect(tilesRegion()).toHaveTextContent("There is no ArcGIS Pro project (.aprx) in this upload"));
  expect(tilesOption()).toBeDisabled();

  vi.mocked(inspectColorTheme).mockResolvedValue(layerFilesInspection());
  pickFolder([inFolder("DemoSta.aprx", "DemoSta_layers"), inFolder("DemoSta_units.aprx", "DemoSta_layers")]);
  await screen.findByRole("heading", { level: 1, name: "Recolour DemoSta_layers" });
  expect(tilesRegion()).toHaveTextContent("This upload has 2 ArcGIS Pro projects (.aprx)");
  expect(tilesOption()).toBeDisabled();
});

test("left unticked, Download converts exactly as before and starts no build", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(convertColorTheme).mockResolvedValue({ blob: new Blob(["zip"]), filename: "shinjuku_new-colors.zip" });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  expect(tilesOption()).not.toBeChecked();

  fireEvent.click(within(screen.getByRole("region", { name: "Next step" })).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(saved).toEqual(["shinjuku_new-colors.zip"]));
  expect(startTileBuild).not.toHaveBeenCalled();
  expect(fetchTileJob).not.toHaveBeenCalled();
});

test("ticked, Download queues a build, shows its place in line and its steps, and downloads the zip when done", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "a1b2c3" });
  vi.mocked(fetchTileJob)
    .mockResolvedValueOnce({ state: "queued", position: 1 })
    .mockResolvedValueOnce({ state: "running", step: 2, of: 5, label: "Map metadata" })
    .mockResolvedValueOnce({
      state: "done",
      filename: "shinjuku_new-colors.zip",
      warnings: ["These groups have no layer chosen and are switched off: ordinal_-1, WiFi"],
      problems: ["missing zoom levels [21]"]
    });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await tickTilesKeepingDefaults();
  const bar = screen.getByRole("region", { name: "Next step" });
  expect(bar).toHaveTextContent("Vector tiles will be built");

  fireEvent.click(within(bar).getByRole("button", { name: "Download" }));

  const status = await within(tilesRegion()).findByRole("status");
  await waitFor(() => expect(status).toHaveTextContent("Waiting for another build to finish · number 1 in line"));
  expect(vi.mocked(startTileBuild).mock.calls[0][0]).toBe(vi.mocked(inspectColorTheme).mock.calls[0][0]);
  expect(vi.mocked(startTileBuild).mock.calls[0][1]).toMatchObject({
    styleFiles: true,
    layers: ["CIMPATH=stenavi/JRSta_1_Space.json", "CIMPATH=stenavi/背景.json"]
  });
  expect(convertColorTheme).not.toHaveBeenCalled();
  expect(vi.mocked(fetchTileJob).mock.calls[0][0]).toBe("a1b2c3");
  expect(within(bar).getByRole("button", { name: /Building tiles…/ })).toBeDisabled();
  expect(tilesOption()).toBeDisabled();

  await waitFor(() => expect(status).toHaveTextContent("Step 2 of 5 · Map metadata"), { timeout: 2500 });
  expect(bar).toHaveTextContent("Building vector tiles");

  await waitFor(() => expect(saved).toEqual(["shinjuku_new-colors.zip"]), { timeout: 2500 });
  expect(followed).toEqual(["/api/color-theme/jobs/a1b2c3/download"]);
  expect(bar).toHaveTextContent("Downloaded shinjuku_new-colors.zip");
  expect(within(tilesRegion()).queryByRole("status")).toBeNull();
  expect(tilesRegion()).toHaveTextContent("missing zoom levels [21]");
  expect(tilesRegion()).toHaveTextContent("no layer chosen and are switched off: ordinal_-1, WiFi");
  expect(fetchTileJob).toHaveBeenCalledTimes(3);
});

test("a failed build shows the worker's reason and leaves the check to try again", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "a1b2c3" });
  vi.mocked(fetchTileJob).mockResolvedValue({ state: "failed", reason: "2 layers have no data in the upload: 1F, 2F" });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await tickTilesKeepingDefaults();
  const bar = screen.getByRole("region", { name: "Next step" });

  fireEvent.click(within(bar).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(bar).toHaveTextContent("Vector tiles failed: 2 layers have no data in the upload: 1F, 2F"));
  expect(within(bar).getByRole("button", { name: "Download" })).toBeEnabled();
  expect(saved).toEqual([]);
});

test("a build the server no longer knows says so", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "gone" });
  vi.mocked(fetchTileJob).mockRejectedValue(new ApiClientError(404, "TILE_JOB_NOT_FOUND", "not on the server"));
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await tickTilesKeepingDefaults();
  const bar = screen.getByRole("region", { name: "Next step" });

  fireEvent.click(within(bar).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(bar).toHaveTextContent("The server no longer has this vector tile build"));
});

test("in Japanese the option, its note and the build's progress read in Japanese", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "a1b2c3" });
  vi.mocked(fetchTileJob).mockResolvedValue({ state: "queued", position: 2 });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);

  const option = await screen.findByRole("checkbox", { name: /Stenavi 用のベクタータイルを作成/ });
  await waitFor(() => expect(option).toBeEnabled());
  const region = screen.getByRole("region", { name: "ベクタータイル" });
  expect(region).toHaveTextContent("レイヤー一覧でチェックしたレイヤーだけがタイルになります");
  fireEvent.click(option);
  const dialog = screen.getByRole("dialog", { name: "タイルにするレイヤー" });
  expect(dialog).toHaveTextContent("グループ 4 件、レイヤー 9 件 · タイル化 2 件 · パターンで除外 6 件");
  expect(dialog).toHaveTextContent("除外 · Facility_Merge_*");
  expect(dialog).toHaveTextContent("プロジェクトで非表示");
  expect(within(dialog).getByRole("button", { name: "既定に戻す" })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "このレイヤーを使う" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(region).toHaveTextContent("グループ 4 件、レイヤー 9 件 · タイル化 2 件 · パターンで除外 6 件");
  expect(within(region).getByRole("button", { name: "レイヤーを選ぶ…" })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("region", { name: "次のステップ" })).getByRole("button", { name: "ダウンロード" }));

  expect(await within(region).findByRole("status")).toHaveTextContent("ほかの作成の完了を待っています · 2 番目");
});

test("ticking vector tiles opens the layer list: saved visibility less the patterns, explained row by row", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());

  fireEvent.click(tilesOption());

  expect(layersDialog()).toHaveTextContent("4 groups, 9 layers · 2 to tile · 6 excluded by pattern");
  expect(layersDialog()).toHaveTextContent("Ticked layers of the map “Stenavi” go into the vector tiles");
  expect(layerBox("ordinal_1")).toHaveAttribute("aria-checked", "mixed");
  expect(layerBox("Facility_Merge_1")).not.toBeChecked();
  expect(layerBox("ordinal_-1")).not.toBeChecked();
  expect(layerBox("WiFi")).not.toBeChecked();
  expect(layerBox("背景")).toBeChecked();
  const row = (name: string) => layerBox(name).closest("div") as HTMLElement;
  expect(row("Facility_Merge_1")).toHaveTextContent("excluded · Facility_Merge_*");
  expect(row("WiFi")).toHaveTextContent("excluded · wifi");
  expect(row("ordinal_-1")).toHaveTextContent("hidden in project");
  expect(row("背景")).not.toHaveTextContent("excluded");
  expect(within(layersDialog()).queryByRole("checkbox", { name: "JRSta_1_Space" })).toBeNull();

  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Expand JRSta_1F" }));

  expect(layerBox("JRSta_1F")).toHaveAttribute("aria-checked", "mixed");
  expect(layerBox("JRSta_1_Space")).toBeChecked();
  expect(within(row("JRSta_1_level")).getByText("excluded · *_level")).toBeInTheDocument();
  expect(row("JRSta_1_level")).toHaveTextContent("hidden in project");
});

test("a group's tick sets every layer in it, a partly ticked group shows a dash, and the summary follows", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());

  fireEvent.click(layerBox("ordinal_1"));
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Expand JRSta_1F" }));

  expect(layerBox("ordinal_1")).toBeChecked();
  expect(layerBox("JRSta_1F")).toBeChecked();
  expect(layerBox("JRSta_1_level")).toBeChecked();
  expect(layersDialog()).toHaveTextContent("· 6 to tile ·");

  fireEvent.click(layerBox("JRSta_1_opening"));

  expect(layerBox("JRSta_1F")).toHaveAttribute("aria-checked", "mixed");
  expect(layerBox("ordinal_1")).toHaveAttribute("aria-checked", "mixed");
  expect(layersDialog()).toHaveTextContent("· 5 to tile ·");

  fireEvent.click(layerBox("ordinal_1"));

  expect(layerBox("ordinal_1")).toBeChecked();
  fireEvent.click(layerBox("ordinal_1"));
  expect(layerBox("ordinal_1")).not.toBeChecked();
  expect(layerBox("JRSta_1_Space")).not.toBeChecked();
  expect(layersDialog()).toHaveTextContent("· 1 to tile ·");
});

test("reset puts the defaults back, and with nothing ticked the list cannot be used", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());

  fireEvent.click(layerBox("ordinal_1"));
  fireEvent.click(layerBox("背景"));
  fireEvent.click(layerBox("ordinal_1"));
  expect(layersDialog()).toHaveTextContent("· 0 to tile ·");
  expect(within(layersDialog()).getByRole("button", { name: "Use these layers" })).toBeDisabled();

  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Reset to defaults" }));

  expect(layersDialog()).toHaveTextContent("4 groups, 9 layers · 2 to tile · 6 excluded by pattern");
  expect(layerBox("ordinal_1")).toHaveAttribute("aria-checked", "mixed");
  expect(layerBox("背景")).toBeChecked();
  expect(within(layersDialog()).getByRole("button", { name: "Use these layers" })).toBeEnabled();
});

test("the chosen layers are sent in drawing order, Cancel keeps the previous choice, and a new drop starts over", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "a1b2c3" });
  vi.mocked(fetchTileJob).mockResolvedValue({ state: "queued", position: 1 });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());
  fireEvent.click(layerBox("ordinal_-1"));
  fireEvent.click(layerBox("背景"));
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Use these layers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(tilesRegion()).toHaveTextContent("· 2 to tile ·");

  fireEvent.click(within(tilesRegion()).getByRole("button", { name: "Choose layers…" }));
  expect(layerBox("ordinal_-1")).toBeChecked();
  fireEvent.click(layerBox("ordinal_-1"));
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(tilesRegion()).toHaveTextContent("· 2 to tile ·");

  fireEvent.click(within(screen.getByRole("region", { name: "Next step" })).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(startTileBuild).toHaveBeenCalledTimes(1));
  expect(vi.mocked(startTileBuild).mock.calls[0][1].layers).toEqual([
    "CIMPATH=stenavi/JRSta_1_Space.json",
    "CIMPATH=stenavi/JRSta_B1_Space.json"
  ]);

  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(within(tilesRegion()).getByRole("button", { name: "Choose layers…" })).toBeEnabled());
  fireEvent.click(within(tilesRegion()).getByRole("button", { name: "Choose layers…" }));
  expect(layerBox("ordinal_-1")).not.toBeChecked();
  expect(layerBox("背景")).toBeChecked();
});

test("with one map there is no map to choose, and the build is sent that map", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue(shinjukuProjectInspection());
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "a1b2c3" });
  vi.mocked(fetchTileJob).mockResolvedValue({ state: "queued", position: 1 });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());

  expect(within(layersDialog()).queryByRole("combobox")).toBeNull();
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Use these layers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(within(screen.getByRole("region", { name: "Next step" })).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(startTileBuild).toHaveBeenCalledTimes(1));
  expect(vi.mocked(startTileBuild).mock.calls[0][1].map).toBe("CIMPATH=map0/map.json");
});

const mapPicker = () => within(layersDialog()).getByRole("combobox", { name: "Map to tile" });

test("with several maps the default is chosen and explained, an empty map cannot be picked, and the build is sent the map", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue({ ...shinjukuProjectInspection(), tile_layers: shinjukuTileMaps() });
  vi.mocked(startTileBuild).mockResolvedValue({ job_id: "a1b2c3" });
  vi.mocked(fetchTileJob).mockResolvedValue({ state: "queued", position: 1 });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());

  expect(mapPicker()).toHaveTextContent("マップ レイヤー · 9 layers");
  expect(layersDialog()).toHaveTextContent("“マップ レイヤー” is the default: it has the most layers.");
  expect(layersDialog()).toHaveTextContent("Ticked layers of the chosen map go into the vector tiles");
  expect(layersDialog()).toHaveTextContent("4 groups, 9 layers · 2 to tile");
  fireEvent.click(mapPicker());
  expect(await screen.findByRole("option", { name: "マップ · no layers" })).toHaveAttribute("aria-disabled", "true");

  fireEvent.click(screen.getByRole("option", { name: "ホーム · 2 layers" }));

  expect(mapPicker()).toHaveTextContent("ホーム · 2 layers");
  expect(layersDialog()).toHaveTextContent("1 group, 2 layers · 1 to tile · 0 excluded by pattern");
  expect(layerBox("ホーム")).toHaveAttribute("aria-checked", "mixed");
  expect(layerBox("Platform_1")).toBeChecked();
  expect(layerBox("Platform_2")).not.toBeChecked();
  fireEvent.click(layerBox("Platform_2"));
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Use these layers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(tilesRegion()).toHaveTextContent("1 group, 2 layers · 2 to tile");
  fireEvent.click(within(screen.getByRole("region", { name: "Next step" })).getByRole("button", { name: "Download" }));

  await waitFor(() => expect(startTileBuild).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(startTileBuild).mock.calls[0][1];
  expect([sent.map, sent.layers]).toEqual([
    "CIMPATH=map2/map.json",
    ["CIMPATH=stenavi/Platform_1.json", "CIMPATH=stenavi/Platform_2.json"]
  ]);
});

test("switching maps starts the new map from its defaults, and reset goes back to the default map", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue({ ...shinjukuProjectInspection(), tile_layers: shinjukuTileMaps() });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesOption()).toBeEnabled());
  fireEvent.click(tilesOption());
  fireEvent.click(layerBox("背景"));
  expect(layersDialog()).toHaveTextContent("· 1 to tile ·");

  fireEvent.click(mapPicker());
  fireEvent.click(await screen.findByRole("option", { name: "ホーム · 2 layers" }));
  fireEvent.click(layerBox("Platform_1"));
  expect(layersDialog()).toHaveTextContent("· 0 to tile ·");
  fireEvent.click(mapPicker());
  fireEvent.click(await screen.findByRole("option", { name: "マップ レイヤー · 9 layers" }));

  expect(layersDialog()).toHaveTextContent("4 groups, 9 layers · 2 to tile");
  expect(layerBox("背景")).toBeChecked();

  fireEvent.click(mapPicker());
  fireEvent.click(await screen.findByRole("option", { name: "ホーム · 2 layers" }));
  fireEvent.click(within(layersDialog()).getByRole("button", { name: "Reset to defaults" }));

  expect(mapPicker()).toHaveTextContent("マップ レイヤー · 9 layers");
  expect(layersDialog()).toHaveTextContent("4 groups, 9 layers · 2 to tile");
});

test("the map list speaks Japanese", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue({ ...shinjukuProjectInspection(), tile_layers: shinjukuTileMaps() });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  const option = await screen.findByRole("checkbox", { name: /Stenavi 用のベクタータイルを作成/ });
  await waitFor(() => expect(option).toBeEnabled());
  fireEvent.click(option);

  const dialog = screen.getByRole("dialog", { name: "タイルにするレイヤー" });
  const picker = within(dialog).getByRole("combobox", { name: "タイルにするマップ" });
  expect(picker).toHaveTextContent("マップ レイヤー · レイヤー 9 件");
  expect(dialog).toHaveTextContent("既定は「マップ レイヤー」です。レイヤーがいちばん多いマップです。");
  fireEvent.click(picker);
  expect(await screen.findByRole("option", { name: "マップ · レイヤーなし" })).toHaveAttribute("aria-disabled", "true");
});

test("a project whose maps have no layers, or whose layers cannot be read, cannot be tiled and says why", async () => {
  vi.mocked(fetchVectorTilesAvailability).mockResolvedValue(LICENSED);
  vi.mocked(inspectColorTheme).mockResolvedValue({
    ...shinjukuProjectInspection(),
    tile_layers: { state: "no_layers", maps: ["マップ", "1F"] }
  });
  renderPage();
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);

  await waitFor(() => expect(tilesRegion()).toHaveTextContent("No map in the project has a layer to tile (マップ, 1F)."));
  expect(tilesOption()).toBeDisabled();

  vi.mocked(inspectColorTheme).mockResolvedValue({
    ...shinjukuProjectInspection(),
    tile_layers: { state: "unreadable", detail: "The project has no member GISProject.json" }
  });
  pickFolder([inFolder("shinjuku.aprx", "shinjuku")]);
  await waitFor(() => expect(tilesRegion()).toHaveTextContent("The project’s layers could not be read: The project has no member GISProject.json"));
  expect(tilesOption()).toBeDisabled();
});
