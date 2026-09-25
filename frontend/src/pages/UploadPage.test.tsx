import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import {
  detectAllFiles,
  fetchSessionFeatures,
  importImdfShapefiles,
  importShapefiles,
  updateSessionFile,
  type ImportedFile
} from "../api/client";
import { ApiClientError } from "../api/errors";
import { ToastProvider } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";
import { UploadPage } from "./UploadPage";

vi.mock("../api/client", () => ({
  detectAllFiles: vi.fn(),
  fetchSessionFeatures: vi.fn(),
  importImdfShapefiles: vi.fn(),
  importShapefiles: vi.fn(),
  updateSessionFile: vi.fn()
}));

const detectAllFilesMock = vi.mocked(detectAllFiles);
vi.mocked(fetchSessionFeatures).mockResolvedValue({ type: "FeatureCollection", features: [] });
const importImdfShapefilesMock = vi.mocked(importImdfShapefiles);
const importShapefilesMock = vi.mocked(importShapefiles);
const updateSessionFileMock = vi.mocked(updateSessionFile);

const FLOOR_CHECKBOX = /Prefer the floor in the filename/;

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderPage(fromProject = false, entry: string | { pathname: string; state: unknown } = "/p/new") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ToastProvider>
        <Routes>
          <Route path="*" element={<><UploadPage fromProject={fromProject} /><Where /></>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

async function queue(...names: string[]) {
  const input = document.querySelector("input[type=file]") as HTMLInputElement;
  const files = names.map((name) => new File([new Uint8Array([0, 1, 2])], name, { type: "application/octet-stream" }));
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

const parts = (stem: string) => [".shp", ".shx", ".dbf"].map((extension) => `${stem}${extension}`);

function file(stem: string, overrides: Partial<ImportedFile> = {}): ImportedFile {
  return {
    stem,
    geometry_type: "Polygon",
    feature_count: 12,
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

const nextButton = (name: RegExp) => within(nextStep()).getByRole("button", { name });
const nextStep = () => screen.getByRole("region", { name: "Next step" });

beforeEach(() => {
  useAppStore.setState({ sessionId: null, loadedSessionId: null, files: [], importProfile: "standard" });
  importImdfShapefilesMock.mockReset();
  importShapefilesMock.mockReset();
  updateSessionFileMock.mockReset();
  importImdfShapefilesMock.mockResolvedValue({
    session_id: "session-1",
    import_profile: "imdf_shapefile",
    files: [],
    cleanup_summary: null,
    warnings: []
  } as never);
});

describe("new work", () => {
  test("the filename-floor option belongs to IMDF-schema import only", () => {
    renderPage();
    expect(screen.queryByText(FLOOR_CHECKBOX)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /IMDF schema/ }));
    expect(screen.getByText(FLOOR_CHECKBOX)).toBeInTheDocument();
    expect(nextButton(/Import to Check/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Standard/ }));
    expect(screen.queryByText(FLOOR_CHECKBOX)).not.toBeInTheDocument();
    expect(nextButton(/Read the files/)).toBeInTheDocument();
  });

  test("the chosen profile and filename-floor value reach the import call", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("radio", { name: /IMDF schema/ }));
    fireEvent.click(screen.getByText(FLOOR_CHECKBOX));
    await queue(...parts("JRShinjukuSta_B2_unit"));
    fireEvent.click(nextButton(/Import to Check/));

    await waitFor(() => expect(importImdfShapefilesMock).toHaveBeenCalledTimes(1));
    expect(importShapefilesMock).not.toHaveBeenCalled();
    expect(importImdfShapefilesMock.mock.calls[0][2]).toBe(true);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/p/session-1/check"));
  });

  test("files dropped on the hub arrive queued, and new work starts from no project", () => {
    useAppStore.setState({ sessionId: "previous", loadedSessionId: "previous" });
    const dropped = parts("JRTokyoSta_B1_Space").map((name) => new File(["x"], name));
    renderPage(false, { pathname: "/p/new", state: { droppedFiles: dropped } });
    expect(screen.getByText("JRTokyoSta_B1_Space")).toBeInTheDocument();
    expect(screen.getByText(".dbf, .shp, .shx")).toBeInTheDocument();
    expect(useAppStore.getState().sessionId).toBeNull();
    expect(nextStep()).toHaveTextContent("1 file ready to read");
  });

  test("a shapefile missing a part needs you, and holds the import until it is added or left out", async () => {
    renderPage();
    expect(nextButton(/Read the files/)).toBeDisabled();

    await queue(...parts("JRTokyoSta_1_Space"), "JRTokyoSta_B1_Opening.dbf", "JRTokyoSta_B1_Opening.shp");
    const needsYou = screen.getByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByText("JRTokyoSta_B1_Opening")).toBeInTheDocument();
    expect(within(needsYou).getByText(/Its \.shx is missing/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Ready to read" })).getByText("JRTokyoSta_1_Space")).toBeInTheDocument();
    expect(nextStep()).toHaveTextContent("1 file needs a decision before you continue");
    expect(nextButton(/Read the files/)).toBeDisabled();

    await queue("JRTokyoSta_B1_Opening.shx");
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    expect(nextButton(/Read the files/)).toBeEnabled();

    await queue("Stray.shp");
    expect(nextButton(/Read the files/)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Leave out Stray" }));
    expect(nextButton(/Read the files/)).toBeEnabled();
  });

  test("a stray .cpg is passed over, and the import goes ahead without it", async () => {
    importShapefilesMock.mockResolvedValue({
      session_id: "session-3",
      import_profile: "standard",
      files: [file("JRTokyoSta_1_Space")],
      cleanup_summary: null,
      warnings: []
    } as never);
    renderPage();
    await queue(...parts("JRTokyoSta_1_Space"), "Leftover.cpg");
    expect(screen.getByText(/no \.shp, so this is passed over/)).toBeInTheDocument();
    expect(nextStep()).toHaveTextContent("1 file ready to read");
    fireEvent.click(nextButton(/Read the files/));
    await waitFor(() => expect(importShapefilesMock).toHaveBeenCalledTimes(1));
  });

  test("a standard import opens the new project's Bring in to show what was read", async () => {
    importShapefilesMock.mockResolvedValue({
      session_id: "session-2",
      import_profile: "standard",
      files: [file("JRTokyoSta_1_Space")],
      cleanup_summary: null,
      warnings: []
    } as never);
    renderPage();
    await queue(...parts("JRTokyoSta_1_Space"));
    fireEvent.click(nextButton(/Read the files/));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/p/session-2/bring-in"));
    expect(useAppStore.getState().files.map((item) => item.stem)).toEqual(["JRTokyoSta_1_Space"]);
  });
});

describe("a project's Bring in", () => {
  const brought = [
    file("JRTokyoSta_B1_Space", { detected_level: -1 }),
    file("JRTokyoSta_1_Opening", { detected_type: "opening", geometry_type: "LineString" }),
    file("JRTokyoSta_Building", { detected_type: "building", detected_level: null }),
    file("qwzx", { detected_type: "unit", confidence: "yellow", detected_level: null })
  ];

  beforeEach(() => {
    useAppStore.setState({ sessionId: "s1", loadedSessionId: "s1", files: brought, importProfile: "standard" });
  });

  test("groups the files into needs you and look right, with type and floor", () => {
    renderPage(true, "/p/s1/bring-in");
    const needsYou = screen.getByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByText("qwzx")).toBeInTheDocument();
    expect(within(needsYou).getByText(/doesn’t say what this is or which floor\. Its shapes look like Units/)).toBeInTheDocument();
    expect(within(needsYou).getByRole("combobox", { name: "What qwzx is" })).toBeInTheDocument();

    const looksRight = screen.getByRole("region", { name: "Look right" });
    expect(within(looksRight).getAllByRole("listitem")).toHaveLength(3);
    expect(within(looksRight).getByText("Openings (doors, gates)")).toBeInTheDocument();
    expect(within(looksRight).getByText("Whole station")).toBeInTheDocument();
    expect(within(looksRight).getByText("B1F")).toBeInTheDocument();

    const floors = screen.getByRole("region", { name: "Floors we found" });
    expect(within(floors).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["B1F", "1F"]);
  });

  test("the next step waits for every file that needs you", () => {
    renderPage(true, "/p/s1/bring-in");
    expect(nextStep()).toHaveTextContent("1 file needs a decision before you continue");
    expect(nextButton(/Continue to Set up/)).toBeDisabled();

    act(() => {
      useAppStore.setState({
        files: brought.map((item) => (item.stem === "qwzx" ? { ...item, confidence: "green", detected_level: 1 } : item))
      });
    });
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    expect(nextStep()).toHaveTextContent("Every file looks right");
    fireEvent.click(nextButton(/Continue to Set up/));
    expect(screen.getByTestId("where")).toHaveTextContent("/p/s1/set-up");
  });

  async function choose(combobox: string, option: string) {
    fireEvent.click(screen.getByRole("combobox", { name: combobox }));
    fireEvent.click(await screen.findByRole("option", { name: option }));
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  const saved = (next: ImportedFile) => ({ session_id: "s1", file: next, files: [], save_status: "saved" as const, learning_suggestion: null });

  test("a choice saves through the file endpoint and moves the file to look right", async () => {
    const qwzx = brought[3];
    updateSessionFileMock.mockResolvedValueOnce(saved({ ...qwzx, confidence: "green" }));
    renderPage(true, "/p/s1/bring-in");
    await choose("What qwzx is", "Units (rooms & spaces)");
    expect(updateSessionFileMock).toHaveBeenCalledWith("s1", "qwzx", { detected_type: "unit" });
    await screen.findByRole("combobox", { name: "Floor of qwzx" });

    updateSessionFileMock.mockResolvedValueOnce(saved({ ...qwzx, confidence: "green", detected_level: 1 }));
    await choose("Floor of qwzx", "2F");
    expect(updateSessionFileMock).toHaveBeenLastCalledWith("s1", "qwzx", { detected_level: 1 });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument());
    expect(nextButton(/Continue to Set up/)).toBeEnabled();
  });

  test("a choice the server refuses leaves the file needing you and Continue blocked", async () => {
    updateSessionFileMock.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL", "boom", false));
    renderPage(true, "/p/s1/bring-in");
    await choose("What qwzx is", "Units (rooms & spaces)");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "What qwzx is" })).toBeEnabled());
    expect(within(screen.getByRole("region", { name: "Needs you" })).getByText("qwzx")).toBeInTheDocument();
    expect(nextButton(/Continue to Set up/)).toBeDisabled();
  });

  test("each file stays locked until its own save lands, and a late reply does not undo a newer one", async () => {
    const extra = file("zzyx", { detected_type: null, confidence: "red", detected_level: null });
    useAppStore.setState({ files: [...brought, extra] });
    const first = deferred<ReturnType<typeof saved>>();
    const second = deferred<ReturnType<typeof saved>>();
    updateSessionFileMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPage(true, "/p/s1/bring-in");

    await choose("What qwzx is", "Units (rooms & spaces)");
    await choose("What zzyx is", "Fixtures");
    await act(async () => second.resolve(saved({ ...extra, detected_type: "fixture", confidence: "green" })));
    expect(screen.getByRole("combobox", { name: "What qwzx is" })).toBeDisabled();

    await act(async () => first.resolve(saved({ ...brought[3], confidence: "green" })));
    const stems = useAppStore.getState().files.map((item) => [item.stem, item.detected_type, item.confidence]);
    expect(stems).toContainEqual(["qwzx", "unit", "green"]);
    expect(stems).toContainEqual(["zzyx", "fixture", "green"]);
  });

  test("shows the project's profile without offering to change it", () => {
    useAppStore.setState({ importProfile: "imdf_shapefile" });
    renderPage(true, "/p/s1/bring-in");
    expect(screen.getByRole("radio", { name: /IMDF schema/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    fireEvent.click(nextButton(/Continue to Check/));
    expect(screen.getByTestId("where")).toHaveTextContent("/p/s1/check");
  });

  test("a file that looks right can still change type, and a suggested keyword can be remembered", async () => {
    const opening = brought[1];
    const suggestion = {
      source_stem: opening.stem,
      keyword: "Opening",
      feature_type: "fixture",
      affected_stems: ["JRTokyoSta_B1_Opening"],
      message: "Apply suffix 'Opening' as fixture keyword to 1 other files?"
    };
    updateSessionFileMock.mockResolvedValueOnce({ ...saved({ ...opening, detected_type: "fixture" }), learning_suggestion: suggestion });
    renderPage(true, "/p/s1/bring-in");

    await choose(`What ${opening.stem} is`, "Fixtures");
    expect(updateSessionFileMock).toHaveBeenCalledWith("s1", opening.stem, { detected_type: "fixture" });
    expect(await screen.findByText(/Read names ending in “Opening” as Fixtures from now on\? That changes 1 other file/)).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Needs you" })).toHaveTextContent("Needs you · 1");
    const relearned = brought.map((item) =>
      item.stem === opening.stem || item.stem === "qwzx"
        ? { ...item, detected_type: "fixture", confidence: "green" as const, detected_level: 0 }
        : item
    );
    updateSessionFileMock.mockResolvedValueOnce({ ...saved(relearned[1]), files: relearned });
    fireEvent.click(screen.getByRole("button", { name: "Remember it" }));
    expect(updateSessionFileMock).toHaveBeenLastCalledWith("s1", opening.stem, {
      detected_type: "fixture",
      apply_learning: true,
      learning_keyword: "Opening"
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remember it" })).not.toBeInTheDocument());
    const types = useAppStore.getState().files.map((item) => [item.stem, item.detected_type]);
    expect(types).toContainEqual(["qwzx", "fixture"]);
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    expect(nextButton(/Continue to Set up/)).toBeEnabled();
  });

  test("a type can be cleared, and each file says its geometry and GeoPackage layer", async () => {
    useAppStore.setState({
      files: [...brought, file("stations", { source_format: "gpkg", source_layer: "Station_pg", geometry_type: "MultiPolygon" })]
    });
    updateSessionFileMock.mockResolvedValueOnce(saved({ ...brought[0], detected_type: null, confidence: "red" }));
    renderPage(true, "/p/s1/bring-in");
    expect(screen.getByText("MultiPolygon · layer Station_pg")).toBeInTheDocument();
    expect(screen.getAllByText("LineString")).toHaveLength(1);

    await choose("What JRTokyoSta_B1_Space is", "Unknown — decide later");
    expect(updateSessionFileMock).toHaveBeenCalledWith("s1", "JRTokyoSta_B1_Space", { detected_type: null });
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Needs you" })).getByText("JRTokyoSta_B1_Space")).toBeInTheDocument()
    );
  });

  test("guessing the types again takes the server's new reading of every file", async () => {
    detectAllFilesMock.mockResolvedValueOnce({ session_id: "s1", files: brought.map((item) => ({ ...item, confidence: "green", detected_level: 0 })) });
    renderPage(true, "/p/s1/bring-in");
    fireEvent.click(screen.getByRole("button", { name: "Guess the types again" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument());
    expect(detectAllFilesMock).toHaveBeenCalledWith("s1");
  });
});
