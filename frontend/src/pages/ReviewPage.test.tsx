import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";

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
  validateSession
} from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";
import { ReviewPage } from "./ReviewPage";

vi.mock("../api/client", () => ({
  autofixSession: vi.fn(),
  deleteSessionFeature: vi.fn(),
  exportSessionArchive: vi.fn(),
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

vi.mock("../components/review/FilterBar", () => ({
  FilterBar: () => <div data-testid="filter-bar" />
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

vi.mock("../components/review/TablePanel", () => ({
  TablePanel: () => <div data-testid="table-panel" />
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
      "Shapefile (.zip) export is only available for shapefile-backed sessions. This session includes GeoPackage sources, so only IMDF export is available."
    )
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download .imdf" })).toBeEnabled();
});
