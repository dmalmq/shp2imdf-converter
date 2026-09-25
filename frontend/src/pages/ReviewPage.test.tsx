import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  autofixSession,
  deleteSessionFeature,
  exportSessionArchive,
  exportSessionShapefiles,
  fetchFeatureTypeCatalog,
  fetchSessionFeatures,
  fetchSessionFiles,
  fetchStoredValidation,
  generateSessionDraft,
  patchSessionFeature,
  patchSessionFeaturesBulk,
  resolveSessionUnitOverlap,
  resolveSessionUnitOverlapsSafe,
  restoreSessionFeatures,
  type ValidationResponse,
  type WizardState,
  validateSession
} from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { AppShell } from "../components/shell/AppShell";
import { useAppStore } from "../store/useAppStore";
import { ReviewPage } from "./ReviewPage";

vi.mock("../api/client", () => ({
  autofixSession: vi.fn(),
  deleteSessionFeature: vi.fn(),
  exportSessionArchive: vi.fn(),
  exportSessionQgisProject: vi.fn(),
  exportSessionShapefiles: vi.fn(),
  fetchFeatureTypeCatalog: vi.fn(),
  fetchSessionFeatures: vi.fn(),
  fetchSessionFiles: vi.fn(),
  fetchStoredValidation: vi.fn(),
  generateSessionDraft: vi.fn(),
  patchSessionFeature: vi.fn(),
  patchSessionFeaturesBulk: vi.fn(),
  resolveSessionUnitOverlap: vi.fn(),
  resolveSessionUnitOverlapsSafe: vi.fn(),
  restoreSessionFeatures: vi.fn(),
  snapOpening: vi.fn(),
  validateSession: vi.fn()
}));

vi.mock("../components/review/LayerTree", () => ({
  LayerTree: () => <div data-testid="layer-tree" />
}));

vi.mock("../components/review/MapPanel", () => ({
  MapPanel: ({ pin }: { pin?: { content: React.ReactNode } | null }) => <div data-testid="map-panel">{pin?.content}</div>
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
const fetchFeatureTypeCatalogMock = vi.mocked(fetchFeatureTypeCatalog);
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
const fetchStoredValidationMock = vi.mocked(fetchStoredValidation);
const restoreSessionFeaturesMock = vi.mocked(restoreSessionFeatures);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/p/session-123/check"]}>
      <ToastProvider>
        <AppShell>
          <ReviewPage />
        </AppShell>
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

  fetchStoredValidationMock.mockResolvedValue(null);
  fetchFeatureTypeCatalogMock.mockResolvedValue([
    {
      feature_type: "unit",
      geometry: "polygon",
      has_category: true,
      categories: ["road"],
      default_category: "unspecified"
    },
    {
      feature_type: "geofence",
      geometry: "polygon",
      has_category: true,
      categories: ["geofence"],
      default_category: "geofence"
    }
  ]);
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

  const exportButton = await screen.findByRole("button", { name: /^Deliver/ });
  await waitFor(() => expect(exportButton).toBeEnabled());

  fireEvent.click(exportButton);

  await waitFor(() => expect(validateSessionMock).toHaveBeenCalledWith("session-123"));
  expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual([
    "imdf",
    "imdf_zip"
  ]);
  expect(screen.queryByRole("radio", { name: /Shapefiles \(\.zip\)/ })).not.toBeInTheDocument();
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
  const exportButton = await screen.findByRole("button", { name: /^Deliver/ });
  await waitFor(() => expect(exportButton).toBeEnabled());
  fireEvent.click(exportButton);

  await waitFor(() => expect(validateSessionMock).toHaveBeenCalledWith("session-123"));
  const formats = screen.getByRole("radiogroup", { name: "Format" });
  expect(within(formats).getAllByRole("radio")).toHaveLength(5);
  const odc = within(formats).getByRole("radio", { name: /Open Data Contest 2026 shapefiles \(\.zip\)/ });
  expect(odc).toBeChecked();
  fireEvent.click(within(formats).getByRole("radio", { name: /IMDF \(\.zip\)/ }));
  expect(odc).not.toBeChecked();
  fireEvent.click(odc);
  expect(odc).toBeChecked();
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

test("bulk retypes selected polygon units to geofence", async () => {
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
      },
      {
        type: "Feature",
        id: "unit-1",
        feature_type: "unit",
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
        },
        properties: {
          category: "road",
          name: { en: "Road A" }
        }
      },
      {
        type: "Feature",
        id: "unit-2",
        feature_type: "unit",
        geometry: {
          type: "Polygon",
          coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]
        },
        properties: {
          category: "road",
          name: { en: "Road B" }
        }
      }
    ]
  });

  renderPage();
  const exportButton = await screen.findByRole("button", { name: /^Deliver/ });
  await waitFor(() => expect(exportButton).toBeEnabled());

  act(() => {
    useAppStore.setState({ selectedFeatureIds: ["unit-1", "unit-2"] });
  });

  const typeSelect = await screen.findByDisplayValue("Type...");
  await waitFor(() => {
    expect(screen.getByRole("option", { name: "geofence" })).toBeInTheDocument();
  });
  fireEvent.change(typeSelect, { target: { value: "geofence" } });
  expect(typeSelect).toHaveValue("geofence");

  const applyButton = typeSelect.nextElementSibling;
  expect(applyButton).toBeInstanceOf(HTMLButtonElement);
  fireEvent.click(applyButton as HTMLButtonElement);

  await waitFor(() =>
    expect(patchSessionFeaturesBulkMock).toHaveBeenCalledWith("session-123", {
      feature_ids: ["unit-1", "unit-2"],
      action: "patch",
      feature_type: "geofence"
    })
  );
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


test("review sits under the one app header instead of drawing its own", async () => {
  renderPage();
  await waitFor(() => expect(screen.getByRole("button", { name: /^Deliver/ })).toBeEnabled());

  const [banner, ...others] = screen.getAllByRole("banner");
  expect(others).toHaveLength(0);
  expect(within(banner).getByText("shp2imdf")).toBeInTheDocument();
  expect(within(banner).getByRole("link", { name: "Projects" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Switch theme" })).toHaveLength(1);
  expect(screen.getAllByRole("group", { name: "Display language" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /^Deliver/ })).toHaveLength(1);

  const track = screen.getByRole("navigation", { name: "Stages" });
  expect(within(track).getByText("3 · Check").closest("[aria-current]")).toHaveAttribute("aria-current", "step");
});

test("the Deliver stage opens the export dialog", async () => {
  renderPage();
  await waitFor(() => expect(screen.getByRole("button", { name: /^Deliver/ })).toBeEnabled());

  const track = screen.getByRole("navigation", { name: "Stages" });
  fireEvent.click(within(track).getByRole("button", { name: /4 · Deliver/ }));

  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(validateSessionMock).toHaveBeenCalledWith("session-123");
});

function validationOf(errors: ValidationResponse["errors"], warnings: ValidationResponse["warnings"]): ValidationResponse {
  return {
    errors,
    warnings,
    passed: [],
    summary: {
      total_features: 3,
      by_type: {},
      error_count: errors.length,
      warning_count: warnings.length,
      auto_fixable_count: 0,
      checks_passed: 0,
      checks_failed: 0,
      unspecified_count: 0,
      overlap_count: 0,
      opening_issues_count: 0
    }
  };
}

const square = (x: number) => ({
  type: "Polygon",
  coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]
});

const overlapWarnings: ValidationResponse["warnings"] = [
  {
    feature_id: "unit-a",
    related_feature_id: "unit-b",
    check: "overlapping_units",
    message: "Overlaps with unit B.",
    severity: "warning",
    auto_fixable: false,
    overlap_geometry: square(0.5)
  },
  {
    feature_id: "unit-b",
    related_feature_id: "unit-a",
    check: "overlapping_units",
    message: "Overlaps with unit A.",
    severity: "warning",
    auto_fixable: false,
    overlap_geometry: square(0.5)
  }
];

const missingCategory: ValidationResponse["errors"] = [
  {
    feature_id: "unit-a",
    check: "unit_missing_category_error",
    message: "Unit has no category.",
    severity: "error",
    auto_fixable: false
  }
];

function withOverlap() {
  fetchSessionFeaturesMock.mockResolvedValue({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: "level-1", feature_type: "level", geometry: null, properties: { short_name: { en: "1F" }, ordinal: 0 } },
      { type: "Feature", id: "unit-a", feature_type: "unit", geometry: square(0), properties: { name: { en: "Concourse" }, level_id: "level-1" } },
      { type: "Feature", id: "unit-b", feature_type: "unit", geometry: square(0.5), properties: { name: { en: "Gate area" }, level_id: "level-1" } }
    ]
  });
}

test("Check shows the stored validation as must fix and can wait without running the checker", async () => {
  withOverlap();
  fetchStoredValidationMock.mockResolvedValue(validationOf(missingCategory, overlapWarnings));

  renderPage();

  const mustFix = await screen.findByRole("list", { name: "Must fix" });
  expect(within(mustFix).getByText("Space has no category")).toBeInTheDocument();
  expect(within(mustFix).getByText("Concourse")).toBeInTheDocument();
  const canWait = screen.getByRole("region", { name: "Can wait" });
  expect(within(canWait).getByText("Can wait · 2 warnings")).toBeInTheDocument();
  expect(within(canWait).getByText("Two spaces overlap")).toBeInTheDocument();
  expect(screen.getByText("0 fixed · 1 left to fix")).toBeInTheDocument();
  const track = screen.getByRole("navigation", { name: "Stages" });
  expect(within(track).getByText("1 to fix · 2 can wait")).toBeInTheDocument();
  expect(validateSessionMock).not.toHaveBeenCalled();
});

test("keeping one of two overlapping spaces is done, and Undo restores it and the counts", async () => {
  withOverlap();
  const before = validationOf(missingCategory, overlapWarnings);
  const after = validationOf(missingCategory, []);
  const undo = { remove_ids: [], features: [{ id: "unit-b" }] };
  fetchStoredValidationMock.mockResolvedValue(before);
  resolveSessionUnitOverlapMock.mockResolvedValue({
    session_id: "session-123",
    resolved_pairs: 1,
    updated_count: 1,
    deleted_count: 0,
    skipped_count: 0,
    validation: after,
    undo
  });
  restoreSessionFeaturesMock.mockResolvedValue(before);

  renderPage();
  const canWait = await screen.findByRole("region", { name: "Can wait" });
  fireEvent.click(within(canWait).getByRole("button", { name: "Resolve" }));

  const popover = await screen.findByRole("dialog", { name: /These two spaces overlap by/ });
  expect(within(popover).getByText(/Why it matters/)).toBeInTheDocument();
  fireEvent.click(within(popover).getByRole("button", { name: /Keep A · Concourse/ }));
  fireEvent.click(within(popover).getByRole("button", { name: "Keep A and trim B" }));

  await waitFor(() => expect(resolveSessionUnitOverlapMock).toHaveBeenCalledWith("session-123", "unit-a", "unit-b"));
  const doneList = await screen.findByRole("region", { name: "Done" });
  expect(within(doneList).getByText("overlap resolved — kept Concourse")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Can wait" })).not.toBeInTheDocument();

  fireEvent.click(within(doneList).getByRole("button", { name: "Undo" }));

  await waitFor(() => expect(restoreSessionFeaturesMock).toHaveBeenCalledWith("session-123", undo));
  expect(await screen.findByText("Can wait · 2 warnings")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Done" })).not.toBeInTheDocument();
});
