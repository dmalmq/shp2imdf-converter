import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  fetchSessionFeatures,
  fetchSessionFiles,
  fetchWizardState,
  generateSessionDraft,
  patchWizardLevels,
  patchWizardProject,
  type ImportedFile,
  type ProjectWizardState,
  type WizardState
} from "../api/client";
import { ToastProvider } from "../components/shared/ToastProvider";
import { AUTOSAVE_DELAY_MS } from "../components/wizard/wizardSave";
import { useAppStore } from "../store/useAppStore";
import { WizardPage } from "./WizardPage";

vi.mock("../api/client", () => ({
  autofillWizardAddressFromGeometry: vi.fn(),
  detectAllFiles: vi.fn(),
  fetchFootprintPreview: vi.fn(() => Promise.resolve({ footprint: null, venue: null, units_bbox: null })),
  fetchSessionFeatures: vi.fn(),
  fetchSessionFiles: vi.fn(),
  fetchWizardState: vi.fn(),
  generateSessionDraft: vi.fn(),
  getIsoSubdivisions: vi.fn(() => Promise.resolve({ country: "JP", subdivisions: [] })),
  patchWizardBuildings: vi.fn(),
  patchWizardFootprint: vi.fn(),
  patchWizardLevels: vi.fn(),
  patchWizardMappings: vi.fn(),
  patchWizardProject: vi.fn(),
  searchWizardAddress: vi.fn(),
  updateSessionFile: vi.fn(),
  uploadCompanyMappings: vi.fn()
}));

const FILE: ImportedFile = {
  stem: "B1_space",
  geometry_type: "Polygon",
  feature_count: 3,
  attribute_columns: [],
  source_format: "shapefile",
  source_layer: null,
  detected_type: "unit",
  detected_level: -1,
  level_name: "B1",
  short_name: "B1",
  outdoor: false,
  level_category: "unspecified",
  confidence: "high",
  crs_detected: "EPSG:6677",
  warnings: []
};

const COMPLETE_PROJECT: ProjectWizardState = {
  project_name: null,
  venue_name: "Tokyo Station",
  venue_category: "transitstation",
  language: "en",
  venue_restriction: null,
  venue_hours: null,
  venue_phone: null,
  venue_website: null,
  address: {
    address: null,
    unit: null,
    locality: "Chiyoda",
    province: null,
    country: "JP",
    postal_code: null,
    postal_code_ext: null,
    postal_code_vanity: null
  }
};

function wizard(project: ProjectWizardState | null): WizardState {
  return {
    project,
    levels: { items: [] },
    buildings: [
      {
        id: "building-1",
        name: null,
        category: "unspecified",
        restriction: null,
        file_stems: [FILE.stem],
        address_mode: "same_as_venue",
        address: null,
        address_feature_id: null
      }
    ],
    mappings: {
      unit: {
        code_column: "CODE",
        name_column: null,
        alt_name_column: null,
        restriction_column: null,
        accessibility_column: null,
        available_categories: [],
        preview: []
      },
      opening: {
        category_column: null,
        accessibility_column: null,
        access_control_column: null,
        door_automatic_column: null,
        door_material_column: null,
        door_type_column: null,
        name_column: null
      },
      fixture: { name_column: null, alt_name_column: null, category_column: null },
      detail_confirmed: false
    },
    footprint: { method: "union_buffer", footprint_buffer_m: 0, venue_buffer_m: 0, level_gap_fill_m: 0.1 },
    company_mappings: {},
    company_default_category: "unspecified",
    venue_address_feature: null,
    building_address_features: [],
    warnings: [],
    generation_status: "not_started"
  };
}

const patchProjectMock = vi.mocked(patchWizardProject);

// Stands in for the backend's session: every PATCH answers with the whole
// wizard as it is when the request is handled, which is what makes the order
// of concurrent writes matter.
let server: WizardState;

function acceptProjectSaves() {
  patchProjectMock.mockImplementation(async (_session, payload) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    server = { ...server, project: payload };
    return { session_id: "session-1", wizard: server, address_feature: {} };
  });
}

async function renderWizard(project: ProjectWizardState | null) {
  server = wizard(project);
  vi.mocked(fetchWizardState).mockImplementation(async () => ({ session_id: "session-1", wizard: server }));
  render(
    <MemoryRouter>
      <ToastProvider>
        <WizardPage />
      </ToastProvider>
    </MemoryRouter>
  );
  return screen.findByLabelText(/Venue Name/);
}

function type(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function openSection(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
}

const sleep = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    sessionId: "session-1",
    files: [],
    wizardState: null,
    wizardSaveStatus: "idle",
    wizardSaveError: null
  });
  vi.mocked(fetchSessionFiles).mockResolvedValue({ files: [FILE] } as never);
  vi.mocked(fetchSessionFeatures).mockResolvedValue({ features: [] } as never);
  vi.mocked(patchWizardLevels).mockImplementation(async () => {
    const handled = server;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { session_id: "session-1", wizard: handled };
  });
  acceptProjectSaves();
});

test("venue info typed and left for another section at once reaches the backend", async () => {
  await renderWizard(null);

  type(/Venue Name/, "Tokyo Station");
  type(/Locality/, "Chiyoda");
  openSection("Summary & Generate");

  await waitFor(() => expect(patchProjectMock).toHaveBeenCalledTimes(1));
  expect(patchProjectMock.mock.calls[0][1]).toMatchObject({
    venue_name: "Tokyo Station",
    venue_category: "transitstation",
    address: { locality: "Chiyoda", country: "JP" }
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate & open Review" })).toBeEnabled());
  await sleep(100);
  expect(screen.getByText("Tokyo Station")).toBeInTheDocument();
});

test("a burst of typing is saved once, after the typing stops", async () => {
  await renderWizard(COMPLETE_PROJECT);

  for (const value of ["T", "To", "Tok", "Toky", "Tokyo"]) {
    type(/Venue Name/, value);
    await sleep(AUTOSAVE_DELAY_MS / 5);
  }
  expect(patchProjectMock).not.toHaveBeenCalled();

  await waitFor(() => expect(patchProjectMock).toHaveBeenCalledTimes(1));
  await sleep(AUTOSAVE_DELAY_MS * 2);
  expect(patchProjectMock).toHaveBeenCalledTimes(1);
  expect(patchProjectMock.mock.calls[0][1].venue_name).toBe("Tokyo");
  expect(await screen.findByText(/^Saved/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("a failed save says so and can be retried from the footer", async () => {
  patchProjectMock.mockRejectedValueOnce(new Error("backend unavailable"));
  await renderWizard(COMPLETE_PROJECT);

  type(/Venue Name/, "Tokyo Sta.");
  openSection("Buildings");

  expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(patchProjectMock).toHaveBeenCalledTimes(2));
  expect(patchProjectMock.mock.calls[1][1].venue_name).toBe("Tokyo Sta.");
  expect(await screen.findByText(/^Saved/)).toBeInTheDocument();
  expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
});

test("an incomplete venue is kept as a draft across sections, not sent", async () => {
  await renderWizard(null);

  type(/Venue Name/, "Tokyo Station");
  openSection("File Classification");
  openSection("Project & Venue");

  expect(await screen.findByLabelText(/Venue Name/)).toHaveValue("Tokyo Station");
  await sleep(AUTOSAVE_DELAY_MS * 1.5);
  expect(patchProjectMock).not.toHaveBeenCalled();
  expect(screen.getByText(/required to save/)).toBeInTheDocument();
});

test("Summary still generates the draft", async () => {
  vi.mocked(generateSessionDraft).mockResolvedValue({} as never);
  await renderWizard(COMPLETE_PROJECT);

  openSection("Summary & Generate");
  const generate = await screen.findByRole("button", { name: "Generate & open Review" });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);

  await waitFor(() => expect(generateSessionDraft).toHaveBeenCalledWith("session-1"));
  expect(patchProjectMock).not.toHaveBeenCalled();
});
