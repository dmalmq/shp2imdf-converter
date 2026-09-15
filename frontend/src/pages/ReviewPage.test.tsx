import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  autofixSession,
  deleteSessionFeature,
  exportSessionArchive,
  exportSessionShapefiles,
  fetchSessionFeatures,
  fetchSessionFiles,
  generateSessionDraft,
  patchSessionFeature,
  patchSessionFeaturesBulk,
  resolveSessionUnitOverlap,
  resolveSessionUnitOverlapsSafe,
  type WizardState,
  validateSession
} from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";
import { ReviewPage } from "./ReviewPage";

vi.mock("../api/client", () => ({
  autofixSession: vi.fn(),
  deleteSessionFeature: vi.fn(),
  exportSessionArchive: vi.fn(),
  exportSessionQgisProject: vi.fn(),
  exportSessionShapefiles: vi.fn(),
  fetchSessionFeatures: vi.fn(),
  fetchSessionFiles: vi.fn(),
  generateSessionDraft: vi.fn(),
  patchSessionFeature: vi.fn(),
  patchSessionFeaturesBulk: vi.fn(),
  resolveSessionUnitOverlap: vi.fn(),
  resolveSessionUnitOverlapsSafe: vi.fn(),
  validateSession: vi.fn()
}));

vi.mock("../components/review/LayerTree", () => ({
  LayerTree: () => <div data-testid="layer-tree" />
}));

vi.mock("../components/review/MapPanel", () => ({
  MapPanel: () => <div data-testid="map-panel" />
}));

vi.mock("../components/review/PropertiesPanel", () => ({
  PropertiesPanel: () => <div data-testid="properties-panel" />
}));

vi.mock("../components/shared/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

vi.mock("../components/shared/SkeletonBlock", () => ({
  SkeletonBlock: ({ className }: { className?: string }) => <div className={className} data-testid="skeleton" />
}));

const fetchSessionFilesMock = vi.mocked(fetchSessionFiles);
const fetchSessionFeaturesMock = vi.mocked(fetchSessionFeatures);
const generateSessionDraftMock = vi.mocked(generateSessionDraft);
const validateSessionMock = vi.mocked(validateSession);
const exportSessionArchiveMock = vi.mocked(exportSessionArchive);
const exportSessionShapefilesMock = vi.mocked(exportSessionShapefiles);
const autofixSessionMock = vi.mocked(autofixSession);
const deleteSessionFeatureMock = vi.mocked(deleteSessionFeature);
const patchSessionFeatureMock = vi.mocked(patchSessionFeature);
const patchSessionFeaturesBulkMock = vi.mocked(patchSessionFeaturesBulk);
const resolveSessionUnitOverlapMock = vi.mocked(resolveSessionUnitOverlap);
const resolveSessionUnitOverlapsSafeMock = vi.mocked(resolveSessionUnitOverlapsSafe);

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ReviewPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  useAppStore.setState({
    sessionId: "session-123",
    importProfile: "standard",
    currentScreen: "review",
    files: [
      {
        stem: "station__units",
        geometry_type: "Polygon",
        feature_count: 1,
        attribute_columns: ["name"],
        source_format: "gpkg",
        source_layer: "units",
        detected_type: "unit",
        detected_level: 0,
        level_name: null,
        short_name: null,
        outdoor: false,
        level_category: "unspecified",
        confidence: "green",
        crs_detected: "EPSG:4326",
        warnings: []
      }
    ],
    wizardState: null,
    selectedFeatureIds: [],
    filters: {},
    layerVisibility: {},
    validationResults: { errors: 0, warnings: 0 },
    editHistory: []
  });

  fetchSessionFilesMock.mockResolvedValue({
    session_id: "session-123",
    import_profile: "standard",
    files: useAppStore.getState().files
  });
  fetchSessionFeaturesMock.mockResolvedValue({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "level-1",
        feature_type: "level",
        geometry: null,
        properties: {
          name: { en: "Ground" },
          short_name: { en: "G" },
          ordinal: 0
        }
      }
    ]
  });
  generateSessionDraftMock.mockResolvedValue({
    session_id: "session-123",
    status: "draft",
    generated_feature_count: 1,
    message: "ok"
  });
  validateSessionMock.mockResolvedValue({
    errors: [],
    warnings: [],
    passed: [],
    summary: {
      total_features: 1,
      by_type: { level: 1 },
      error_count: 0,
      warning_count: 0,
      auto_fixable_count: 0,
      checks_passed: 1,
      checks_failed: 0,
      unspecified_count: 0,
      overlap_count: 0,
      opening_issues_count: 0
    }
  });
  exportSessionArchiveMock.mockResolvedValue({ blob: new Blob(), filename: "output.imdf" });
  exportSessionShapefilesMock.mockResolvedValue({ blob: new Blob(), filename: "output_shapefiles.zip" });
  autofixSessionMock.mockResolvedValue({
    fixes_applied: [],
    fixes_requiring_confirmation: [],
    total_fixed: 0,
    total_requiring_confirmation: 0,
    revalidation: {
      errors: [],
      warnings: [],
      passed: [],
      summary: {
        total_features: 1,
        by_type: { level: 1 },
        error_count: 0,
        warning_count: 0,
        auto_fixable_count: 0,
        checks_passed: 1,
        checks_failed: 0,
        unspecified_count: 0,
        overlap_count: 0,
        opening_issues_count: 0
      }
    }
  });
  deleteSessionFeatureMock.mockResolvedValue({ session_id: "session-123", deleted_id: "feature-1" });
  patchSessionFeatureMock.mockResolvedValue({
    type: "Feature",
    id: "feature-1",
    feature_type: "unit",
    geometry: null,
    properties: {}
  });
  patchSessionFeaturesBulkMock.mockResolvedValue({
    updated_count: 0,
    deleted_count: 0,
    merged_feature_id: null
  });
  resolveSessionUnitOverlapMock.mockResolvedValue({
    session_id: "session-123",
    resolved_pairs: 0,
    updated_count: 0,
    deleted_count: 0,
    skipped_count: 0,
    validation: {
      errors: [],
      warnings: [],
      passed: [],
      summary: {
        total_features: 1,
        by_type: { level: 1 },
        error_count: 0,
        warning_count: 0,
        auto_fixable_count: 0,
        checks_passed: 1,
        checks_failed: 0,
        unspecified_count: 0,
        overlap_count: 0,
        opening_issues_count: 0
      }
    }
  });
  resolveSessionUnitOverlapsSafeMock.mockResolvedValue({
    session_id: "session-123",
    resolved_pairs: 0,
    updated_count: 0,
    deleted_count: 0,
    skipped_count: 0,
    validation: {
      errors: [],
      warnings: [],
      passed: [],
      summary: {
        total_features: 1,
        by_type: { level: 1 },
        error_count: 0,
        warning_count: 0,
        auto_fixable_count: 0,
        checks_passed: 1,
        checks_failed: 0,
        unspecified_count: 0,
        overlap_count: 0,
        opening_issues_count: 0
      }
    }
  });
});

test("hides shapefile export when the session includes geopackage sources", async () => {
  renderPage();

  const exportButton = await screen.findByRole("button", { name: "Export" });
  await waitFor(() => expect(exportButton).toBeEnabled());

  fireEvent.click(exportButton);

  await waitFor(() => expect(validateSessionMock).toHaveBeenCalledWith("session-123"));
  expect(screen.queryByRole("option", { name: "Shapefiles (.zip)" })).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "This session includes GeoPackage sources, so only IMDF export is available."
    )
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download .imdf" })).toBeEnabled();
});

test("requires an explicit prefix for open data export", async () => {
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const wizardState = {
    project: {
      project_name: "JRTokyoSta",
      venue_name: "JR Tokyo Station",
      language: "en"
    },
    mappings: { unit: { code_column: null } },
    company_mappings: {}
  } as unknown as WizardState;
  useAppStore.setState({
    importProfile: "imdf_shapefile",
    files: [],
    wizardState
  });
  fetchSessionFilesMock.mockResolvedValue({
    session_id: "session-123",
    import_profile: "imdf_shapefile",
    files: []
  });

  renderPage();
  const exportButton = await screen.findByRole("button", { name: "Export" });
  await waitFor(() => expect(exportButton).toBeEnabled());
  fireEvent.click(exportButton);

  await waitFor(() => expect(validateSessionMock).toHaveBeenCalledWith("session-123"));
  fireEvent.click(screen.getByRole("combobox", { name: "Format" }));
  fireEvent.click(
    await screen.findByRole("option", { name: "Open Data Contest 2026 shapefiles (.zip)" })
  );
  const nameInput = await screen.findByRole("textbox", { name: /Export file prefix/ });
  expect(nameInput).toHaveValue("");

  fireEvent.click(screen.getByRole("button", { name: "Download ODC 2026 .zip" }));
  expect(await screen.findAllByText("Enter an export file prefix.")).not.toHaveLength(0);
  expect(exportSessionShapefilesMock).not.toHaveBeenCalled();

  fireEvent.change(nameInput, { target: { value: "TokyoSta" } });
  fireEvent.click(screen.getByRole("button", { name: "Download ODC 2026 .zip" }));
  await waitFor(() =>
    expect(exportSessionShapefilesMock).toHaveBeenCalledWith(
      "session-123",
      expect.objectContaining({ profile: "odc2026", export_name: "TokyoSta" })
    )
  );
  anchorClick.mockRestore();
});

// The table view and its filter bar were built, tested in isolation, and then
// quietly dropped out of the page — the unit tests kept passing because they
// never asked whether anything rendered them. These do.
test("the table view lists features and its filters narrow them", async () => {
  fetchSessionFeaturesMock.mockResolvedValue({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "unit-1",
        feature_type: "unit",
        geometry: null,
        properties: { name: { en: "Ticket hall" }, category: "room", status: "mapped" }
      },
      {
        type: "Feature",
        id: "opening-1",
        feature_type: "opening",
        geometry: null,
        properties: { name: { en: "North door" }, category: "pedestrian", status: "mapped" }
      }
    ]
  });

  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Table" }));

  expect(await screen.findByText("Ticket hall")).toBeInTheDocument();
  expect(screen.getByText("North door")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("combobox", { name: "Type" }));
  fireEvent.click(await screen.findByRole("option", { name: "opening" }));

  await waitFor(() => expect(screen.queryByText("Ticket hall")).not.toBeInTheDocument());
  expect(screen.getByText("North door")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(await screen.findByText("Ticket hall")).toBeInTheDocument();
});

test("selecting a table row selects it for the rest of the screen", async () => {
  fetchSessionFeaturesMock.mockResolvedValue({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "unit-1",
        feature_type: "unit",
        geometry: null,
        properties: { name: { en: "Ticket hall" }, category: "room", status: "mapped" }
      }
    ]
  });

  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Table" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Ticket hall" }));

  await waitFor(() =>
    expect(useAppStore.getState().selectedFeatureIds).toEqual(["unit-1"])
  );
});
