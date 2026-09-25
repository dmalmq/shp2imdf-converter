import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  exportSessionArchive,
  exportSessionQgisProject,
  exportSessionShapefiles,
  fetchExportContents,
  fetchStoredValidation,
  validateSession,
  type ExportContents,
  type ImportedFile,
  type ValidationResponse,
  type WizardState
} from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { AppShell } from "../components/shell/AppShell";
import { useAppStore } from "../store/useAppStore";
import { DeliverPage } from "./DeliverPage";

vi.mock("../api/client", () => ({
  exportSessionArchive: vi.fn(),
  exportSessionQgisProject: vi.fn(),
  exportSessionShapefiles: vi.fn(),
  fetchExportContents: vi.fn(),
  fetchStoredValidation: vi.fn(),
  validateSession: vi.fn()
}));

const ODC = ["Site", "Building", "B1_Floor", "B1_Space"].map((layer) => `JRTokyoSta_${layer}.shp`);

const CONTENTS: ExportContents[] = [
  { format: "imdf", filename: "Tokyo_Station.imdf", entries: ["manifest.json", "unit.geojson"], unavailable: null, rows_skipped: [] },
  { format: "imdf_zip", filename: "Tokyo_Station.zip", entries: ["manifest.json", "unit.geojson"], unavailable: null, rows_skipped: [] },
  { format: "shapefiles", filename: "Tokyo_Station_shapefiles.zip", entries: ["JRTokyoSta_B1_unit.shp"], unavailable: null, rows_skipped: [] },
  { format: "odc2026_shapefiles", filename: "JRTokyoSta_odc2026_shapefiles.zip", entries: ODC, unavailable: null, rows_skipped: [] },
  { format: "qgis_project", filename: "JRTokyoSta_qgis_project.zip", entries: ["JRTokyoSta_qgis.qgz", ...ODC], unavailable: null, rows_skipped: [] }
];

function summary(errors: number, warnings: number): ValidationResponse {
  return {
    errors: [],
    warnings: [],
    passed: [],
    summary: {
      total_features: 10,
      by_type: {},
      error_count: errors,
      warning_count: warnings,
      auto_fixable_count: 0,
      checks_passed: 0,
      checks_failed: 0,
      unspecified_count: 0,
      overlap_count: 0,
      opening_issues_count: 0
    }
  };
}

function file(stem: string, sourceFormat: "shapefile" | "gpkg" = "shapefile"): ImportedFile {
  return { stem, source_format: sourceFormat } as ImportedFile;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/p/session-123/deliver"]}>
      <ToastProvider>
        <AppShell>
          <DeliverPage />
        </AppShell>
      </ToastProvider>
    </MemoryRouter>
  );
}

const outputs = () => screen.getAllByRole("checkbox");
const checkbox = (name: RegExp) => screen.getByRole("checkbox", { name });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  window.URL.createObjectURL = vi.fn(() => "blob:x");
  window.URL.revokeObjectURL = vi.fn();
  useAppStore.setState({
    sessionId: "session-123",
    importProfile: "standard",
    currentScreen: "review",
    files: [file("JRTokyoSta_B1_Space"), file("JRTokyoSta_1_Space")],
    wizardState: {
      project: { venue_name: "Tokyo Station", language: "en" },
      mappings: { unit: { code_column: "CODE" } },
      company_mappings: {}
    } as unknown as WizardState
  });
  vi.mocked(fetchExportContents).mockResolvedValue(CONTENTS);
  vi.mocked(fetchStoredValidation).mockResolvedValue(summary(0, 5));
  vi.mocked(exportSessionArchive).mockResolvedValue({ blob: new Blob(), filename: "Tokyo_Station.imdf" });
  vi.mocked(exportSessionShapefiles).mockResolvedValue({ blob: new Blob(), filename: "JRTokyoSta_odc2026_shapefiles.zip" });
  vi.mocked(exportSessionQgisProject).mockResolvedValue({ blob: new Blob(), filename: "JRTokyoSta_qgis_project.zip" });
});

test("groups the outputs by audience with the names each download gets", async () => {
  renderPage();
  expect(await screen.findByRole("heading", { level: 1, name: "Deliver Tokyo Station" })).toBeInTheDocument();
  const apple = screen.getByRole("region", { name: "For Apple" });
  expect(within(apple).getAllByRole("checkbox")).toHaveLength(2);
  expect(await within(apple).findByText("Tokyo_Station.imdf")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "For GIS and open data" })).getAllByRole("checkbox")).toHaveLength(3);
  expect(checkbox(/IMDF archive/)).toBeChecked();
  expect(fetchExportContents).toHaveBeenCalledWith("session-123", "JRTokyoSta", "preserve_source");
  expect(await screen.findByText("Nothing left that blocks delivery.")).toBeInTheDocument();
  expect(screen.getByText("5 can wait")).toBeInTheDocument();
});

test("one button in the footer creates every chosen output with the dialog's payloads", async () => {
  renderPage();
  await screen.findByText("Tokyo_Station.imdf");
  fireEvent.click(checkbox(/Open Data Contest 2026/));
  fireEvent.click(checkbox(/QGIS project/));

  const tree = screen.getByRole("list", { name: "Files" });
  expect(within(tree).getByText("└ JRTokyoSta_qgis_project.zip")).toBeInTheDocument();
  expect(within(tree).getAllByText("└ per floor ×1 (B1): _Floor _Space")).toHaveLength(2);
  expect(screen.getByText(/JGD2011 \(EPSG:6668\)/)).toBeInTheDocument();

  const create = screen.getAllByRole("button", { name: /Create 3 outputs/ });
  expect(create).toHaveLength(1);
  fireEvent.click(create[0]);

  await waitFor(() => expect(exportSessionQgisProject).toHaveBeenCalled());
  expect(exportSessionArchive).toHaveBeenCalledWith("session-123", false);
  const odc = {
    profile: "odc2026",
    mode: "source_update",
    encoding: "preserve_source",
    include_report: true,
    export_name: "JRTokyoSta",
    unit: { write_imdf_category: true, imdf_category_field: "IMDF_CAT", overwrite_legacy_code_field: null, legacy_code_map: {} }
  };
  expect(exportSessionShapefiles).toHaveBeenCalledWith("session-123", odc);
  expect(exportSessionQgisProject).toHaveBeenCalledWith("session-123", odc);
  expect(vi.mocked(exportSessionArchive).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(exportSessionQgisProject).mock.invocationCallOrder[0]
  );
});

test("the ODC files wait for a prefix", async () => {
  renderPage();
  await screen.findByText("Tokyo_Station.imdf");
  fireEvent.click(checkbox(/IMDF archive/));
  fireEvent.click(checkbox(/Open Data Contest 2026/));
  fireEvent.change(screen.getByRole("textbox", { name: /File prefix/ }), { target: { value: " " } });

  expect(screen.getByRole("button", { name: "Create the output" })).toBeDisabled();
  expect(exportSessionShapefiles).not.toHaveBeenCalled();
});

test("out-of-date checks say so, and Check again runs them here", async () => {
  vi.mocked(fetchStoredValidation).mockResolvedValue(null);
  vi.mocked(validateSession).mockResolvedValue(summary(2, 0));
  renderPage();

  expect(await screen.findByText("The checks are out of date.")).toBeInTheDocument();
  expect(screen.getByText("Not checked since the last change")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));

  expect(await screen.findByText("2 things still block delivery.")).toBeInTheDocument();
  expect(validateSession).toHaveBeenCalledWith("session-123");
  expect(screen.getByRole("button", { name: "Back to Check" })).toBeInTheDocument();
});

test("a GeoPackage project can only have the IMDF outputs", async () => {
  useAppStore.setState({ files: [file("station", "gpkg")] });
  renderPage();
  await screen.findByText("Tokyo_Station.imdf");

  const gis = screen.getByRole("region", { name: "For GIS and open data" });
  within(gis).getAllByRole("checkbox").forEach((box) => expect(box).toBeDisabled());
  expect(within(gis).getAllByText("Not for projects brought in from GeoPackages.")).toHaveLength(3);
  expect(outputs().filter((box) => !box.hasAttribute("disabled"))).toHaveLength(2);
});
