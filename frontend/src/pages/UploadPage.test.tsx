import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { importImdfShapefiles, importShapefiles, type ImportedFile } from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";
import { UploadPage } from "./UploadPage";

vi.mock("../api/client", () => ({
  importImdfShapefiles: vi.fn(),
  importShapefiles: vi.fn(),
  updateSessionFile: vi.fn()
}));

const importImdfShapefilesMock = vi.mocked(importImdfShapefiles);
const importShapefilesMock = vi.mocked(importShapefiles);

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

  test("shows the project's profile without offering to change it", () => {
    useAppStore.setState({ importProfile: "imdf_shapefile" });
    renderPage(true, "/p/s1/bring-in");
    expect(screen.getByRole("radio", { name: /IMDF schema/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    fireEvent.click(nextButton(/Continue to Check/));
    expect(screen.getByTestId("where")).toHaveTextContent("/p/s1/check");
  });
});
