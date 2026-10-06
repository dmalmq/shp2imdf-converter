import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  convertColorTheme,
  fetchColorTheme,
  inspectColorTheme,
  type ColorThemeInspection
} from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { AppShell } from "../components/shell/AppShell";
import {
  colorThemeReport,
  colorThemeRules,
  counts,
  layerFilesInspection,
  layerFilesRerunInspection,
  rerunInspection,
  TOKYO_GDB,
  tokyoGeodatabaseInspection,
  tokyoInspection
} from "../lib/colorTheme.fixtures";
import { useAppStore } from "../store/useAppStore";
import { ColorThemePage } from "./ColorThemePage";

vi.mock("../api/client", () => ({
  convertColorTheme: vi.fn(),
  fetchColorTheme: vi.fn(),
  inspectColorTheme: vi.fn()
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ uiLanguage: "en" });
  vi.mocked(fetchColorTheme).mockResolvedValue(colorThemeReport());
  vi.mocked(inspectColorTheme).mockResolvedValue(tokyoInspection());
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
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

  pickFolder([inFolder("DemoSta_0_Space.lyrx", "DemoSta_layers"), inFolder("DemoSta.aprx", "DemoSta_layers")]);

  await screen.findByRole("heading", { level: 1, name: "Recolour DemoSta_layers" });
  const symbology = screen.getByRole("region", { name: "Symbology" });
  expect(symbology).toHaveTextContent("DemoSta_layers/DemoSta_0_Space.lyrxLayer file1 redrawn");
  expect(symbology).toHaveTextContent("DemoSta_layers/DemoSta.aprxProject2 redrawn · 1 left as is");
  expect(symbology).toHaveTextContent("Esri does not document editing a project outside ArcGIS Pro. Keep the original");
  const row = (layer: string, index = 0) => within(symbology).getAllByText(layer)[index].closest("tr") as HTMLElement;
  expect(Array.from(row("DemoSta_1_Space").children, (cell) => cell.textContent)).toEqual([
    "DemoSta_1_Space",
    "15 → 7",
    "",
    "RedrawnKept as it was: 赤"
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

  const summary = screen.getByRole("region", { name: "What this station gets" });
  expect(summary).toHaveTextContent("Layers redrawn3");
  expect(summary).toHaveTextContent("Files back untouched0 / 2");
  const returns = screen.getByRole("region", { name: "What comes back" });
  expect(returns).toHaveTextContent(/Layer files \(\.lyrx\) and projects \(\.aprx\) come back with each layer coloured by color2 redrawn/);
  expect(returns).toHaveTextContent("an old 濃鼠 toilet (B007–B014) draws white until its data is converted");
  expect(returns).not.toHaveTextContent(/Shapefiles come back/);
  const next = screen.getByRole("region", { name: "Next step" });
  expect(next).toHaveTextContent("3 layers are redrawn");
  expect(within(next).getByRole("button", { name: "Download" })).toBeEnabled();
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

