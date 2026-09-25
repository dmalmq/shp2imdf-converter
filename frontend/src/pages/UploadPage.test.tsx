import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { importImdfShapefiles, importShapefiles } from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";
import { UploadPage } from "./UploadPage";

vi.mock("../api/client", () => ({
  importImdfShapefiles: vi.fn(),
  importShapefiles: vi.fn()
}));

const importImdfShapefilesMock = vi.mocked(importImdfShapefiles);
const importShapefilesMock = vi.mocked(importShapefiles);

const FLOOR_CHECKBOX = /Prefer the floor in the filename/;

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <UploadPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function queueShapefile() {
  const input = document.querySelector("input[type=file]") as HTMLInputElement;
  const file = new File([new Uint8Array([0, 1, 2])], "JRShinjukuSta_B2_unit.shp", {
    type: "application/octet-stream"
  });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  useAppStore.setState({ sessionId: null, files: [], importProfile: "standard" });
  importImdfShapefilesMock.mockReset();
  importShapefilesMock.mockReset();
  importImdfShapefilesMock.mockResolvedValue({
    session_id: "session-1",
    import_profile: "imdf_shapefile",
    files: [],
    cleanup_summary: null
  } as never);
});

test("the filename-floor option belongs to IMDF-schema import only", () => {
  renderPage();
  expect(screen.queryByText(FLOOR_CHECKBOX)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "IMDF schema" }));
  expect(screen.getByText(FLOOR_CHECKBOX)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Standard" }));
  expect(screen.queryByText(FLOOR_CHECKBOX)).not.toBeInTheDocument();
});

test("the chosen filename-floor value reaches the import call", async () => {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "IMDF schema" }));
  queueShapefile();
  await waitFor(() => expect(screen.getByText(/Import to Review/)).toBeEnabled());

  fireEvent.click(screen.getByText(/Import to Review/));
  await waitFor(() => expect(importImdfShapefilesMock).toHaveBeenCalledTimes(1));
  expect(importImdfShapefilesMock.mock.calls[0][2]).toBe(false);

  importImdfShapefilesMock.mockClear();
  useAppStore.setState({ sessionId: null });
  fireEvent.click(screen.getByText(FLOOR_CHECKBOX));
  queueShapefile();
  fireEvent.click(screen.getByText(/Import to Review/));
  await waitFor(() => expect(importImdfShapefilesMock).toHaveBeenCalledTimes(1));
  expect(importImdfShapefilesMock.mock.calls[0][2]).toBe(true);
});

test("files dropped on the hub arrive queued, and a new import starts from no project", () => {
  useAppStore.setState({ sessionId: "previous", loadedSessionId: "previous" });
  const shp = new File(["x"], "JRTokyoSta_B1_Space.shp");
  const dbf = new File(["x"], "JRTokyoSta_B1_Space.dbf");
  render(
    <MemoryRouter initialEntries={[{ pathname: "/p/new", state: { droppedFiles: [shp, dbf] } }]}>
      <ToastProvider>
        <UploadPage />
      </ToastProvider>
    </MemoryRouter>
  );
  expect(screen.getByText("JRTokyoSta_B1_Space")).toBeInTheDocument();
  expect(screen.getByText(".dbf, .shp")).toBeInTheDocument();
  expect(useAppStore.getState().sessionId).toBeNull();
});
