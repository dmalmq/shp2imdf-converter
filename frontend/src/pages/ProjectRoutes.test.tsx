import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";

import App from "../App";
import {
  fetchProjects,
  fetchSessionFeatures,
  fetchSessionFiles,
  fetchWizardState,
  generateSessionDraft,
  importShapefiles,
  patchWizardProject,
  validateSession,
  type ImportedFile,
  type ProjectWizardState,
  type WizardState
} from "../api/client";
import { ApiClientError } from "../api/errors";
import { AUTOSAVE_DELAY_MS } from "../components/wizard/wizardSave";
import { projectSummary } from "../lib/hub.fixtures";
import { useAppStore } from "../store/useAppStore";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  fetchFeatureTypeCatalog: vi.fn(() => Promise.resolve([])),
  fetchFootprintPreview: vi.fn(() => Promise.resolve({ footprint: null, venue: null, units_bbox: null })),
  fetchProjects: vi.fn(() =>
    Promise.resolve({
      projects: [],
      total: 0,
      limits: { sessions: { idle_days: 30, max_projects: 200 }, artwork: { idle_days: 30, max_projects: 200 } }
    })
  ),
  fetchSessionFeatures: vi.fn(),
  fetchSessionFiles: vi.fn(),
  fetchStoredValidation: vi.fn(() => Promise.resolve(null)),
  fetchWizardState: vi.fn(),
  generateSessionDraft: vi.fn(),
  importShapefiles: vi.fn(),
  getIsoSubdivisions: vi.fn(() => Promise.resolve({ country: "JP", subdivisions: [] })),
  patchWizardBuildings: vi.fn(),
  patchWizardFootprint: vi.fn(),
  patchWizardLevels: vi.fn(),
  patchWizardMappings: vi.fn(),
  patchWizardProject: vi.fn(),
  validateSession: vi.fn()
}));

vi.mock("../components/review/LayerTree", () => ({ LayerTree: () => <div data-testid="layer-tree" /> }));
vi.mock("../components/review/MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("../components/review/PropertiesPanel", () => ({
  PropertiesPanel: () => <div data-testid="properties-panel" />
}));

type Fixture = {
  profile: "standard" | "imdf_shapefile";
  generation: WizardState["generation_status"];
  venue: string;
  files: ImportedFile[];
  /** Drafted features exist, whatever `generation` says now. */
  drafted?: boolean;
  /** Only brought in: Set up has saved no project yet. */
  broughtInOnly?: boolean;
};

function file(stem: string): ImportedFile {
  return {
    stem,
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
}

function project(venue: string): ProjectWizardState {
  return {
    project_name: null,
    venue_name: venue,
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
}

function wizardFor(fixture: Fixture): WizardState {
  return {
    project: fixture.broughtInOnly ? null : project(fixture.venue),
    levels: { items: [] },
    buildings: [],
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
    generation_status: fixture.generation
  } as WizardState;
}

// "tokyo" is still in Set up, "shinjuku" has a generated draft, "ikebukuro"
// has a draft but was opened in Set up since (which resets the status), "ueno"
// is an IMDF-shapefile import (no Set up), "empty" has nothing in it yet, and
// "kanda" is fresh but has a floor-outline file classified as level.
const PROJECTS: Record<string, Fixture> = {
  kanda: {
    profile: "standard",
    generation: "not_started",
    venue: "Kanda",
    files: [file("Kanda_1_Space"), { ...file("Kanda_1_Floor"), detected_type: "level" }]
  },
  tokyo: { profile: "standard", generation: "not_started", venue: "Tokyo Station", files: [file("Tokyo_B1_Space")] },
  shinjuku: { profile: "standard", generation: "generated", venue: "Shinjuku", files: [file("Shinjuku_1_Space")] },
  ikebukuro: {
    profile: "standard",
    generation: "not_started",
    drafted: true,
    venue: "Ikebukuro",
    files: [file("Ikebukuro_1_Space")]
  },
  ueno: { profile: "imdf_shapefile", generation: "generated", venue: "Ueno", files: [file("Ueno_1_Space")] },
  empty: { profile: "standard", generation: "not_started", venue: "", files: [] },
  nishi: {
    profile: "standard",
    generation: "not_started",
    venue: "",
    broughtInOnly: true,
    files: [
      { ...file("Nishi_1_Space"), confidence: "green" },
      { ...file("qxzv"), detected_type: null, detected_level: null, confidence: "red" }
    ]
  }
};

function gone(id: string) {
  return new ApiClientError(404, "SESSION_NOT_FOUND", `Session '${id}' was not found`, true);
}

function lookup(id: string): Fixture {
  const fixture = PROJECTS[id];
  if (!fixture) throw gone(id);
  return fixture;
}

const VALIDATION = {
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
};

const INITIAL = useAppStore.getState();

let navigate: NavigateFunction;
let pathname = "";
const visited: string[] = [];

function Probe() {
  navigate = useNavigate();
  const location = useLocation();
  pathname = location.pathname;
  React.useEffect(() => {
    visited.push(location.pathname);
  }, [location]);
  return null;
}

function renderAt(path: string | string[]) {
  const entries = Array.isArray(path) ? path : [path];
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const sleep = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ ...INITIAL, uiLanguage: "en" }, true);
  visited.length = 0;
  vi.mocked(fetchSessionFiles).mockImplementation(async (id) => {
    const fixture = lookup(id);
    return { session_id: id, import_profile: fixture.profile, files: fixture.files };
  });
  vi.mocked(fetchWizardState).mockImplementation(async (id) => ({ session_id: id, wizard: wizardFor(lookup(id)) }));
  vi.mocked(fetchSessionFeatures).mockImplementation(async (id) => {
    const fixture = lookup(id);
    const drafted = fixture.drafted || fixture.generation !== "not_started";
    // Before generation, features carry their file's detected type, which
    // can be "level"; only generation adds footprints.
    const sourceLevels = fixture.files.some((item) => item.detected_type === "level");
    const level = {
      type: "Feature",
      id: `${id}-level`,
      feature_type: "level",
      geometry: null,
      properties: { name: { en: "Ground" }, short_name: { en: "G" }, ordinal: 0 }
    };
    const footprint = { type: "Feature", id: `${id}-footprint`, feature_type: "footprint", geometry: null, properties: {} };
    return {
      type: "FeatureCollection",
      features: drafted ? [level, footprint] : sourceLevels ? [level] : []
    };
  });
  vi.mocked(generateSessionDraft).mockResolvedValue({
    session_id: "x",
    status: "draft",
    generated_feature_count: 1,
    message: "ok"
  } as never);
  vi.mocked(validateSession).mockResolvedValue(VALIDATION as never);
});

afterEach(async () => {
  await sleep(50);
});

describe("reload on a stage", () => {
  test("Set up hydrates the store from the URL", async () => {
    renderAt("/p/tokyo/set-up");
    await screen.findByLabelText(/Venue name/);
    const state = useAppStore.getState();
    expect(state.sessionId).toBe("tokyo");
    expect(state.files.map((item) => item.stem)).toEqual(["Tokyo_B1_Space"]);
    expect(pathname).toBe("/p/tokyo/set-up");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Tokyo Station");
  });

  test("Check renders Review", async () => {
    renderAt("/p/shinjuku/check");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Deliver/ })).toBeEnabled());
    expect(pathname).toBe("/p/shinjuku/check");
    const track = screen.getByRole("navigation", { name: "Stages" });
    expect(within(track).getByText("3 · Check").closest("[aria-current]")).toHaveAttribute("aria-current", "step");
  });

  test("Deliver lands in Review with the export dialog open", async () => {
    renderAt("/p/shinjuku/deliver");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(validateSession).toHaveBeenCalledWith("shinjuku");
    expect(pathname).toBe("/p/shinjuku/deliver");

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(pathname).toBe("/p/shinjuku/check"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Bring in shows what the project brought in", async () => {
    renderAt("/p/tokyo/bring-in");
    expect(await screen.findByRole("heading", { name: "Bring in the floor files" })).toBeInTheDocument();
    expect(screen.getByText("Tokyo_B1_Space")).toBeInTheDocument();
    expect(useAppStore.getState().sessionId).toBe("tokyo");
  });

  test("the import profile survives a reload", async () => {
    renderAt("/p/ueno/check");
    await waitFor(() => expect(useAppStore.getState().loadedSessionId).toBe("ueno"));
    expect(useAppStore.getState().importProfile).toBe("imdf_shapefile");
    const track = screen.getByRole("navigation", { name: "Stages" });
    expect(within(track).getByText("Not needed for IMDF shapefiles")).toBeInTheDocument();
  });
});

test("Save and leave, then Continue on the hub, comes back to the files that still need a decision", async () => {
  renderAt("/p/nishi/bring-in");
  const needsYou = await screen.findByRole("region", { name: "Needs you" });
  expect(within(needsYou).getByText("qxzv")).toBeInTheDocument();

  vi.mocked(fetchProjects).mockResolvedValue({
    projects: [projectSummary({ id: "nishi", name: "Nishi", stage: "bring-in", blockers: null, can_wait: null })],
    total: 1,
    limits: { sessions: { idle_days: 30, max_projects: 200 }, artwork: { idle_days: 30, max_projects: 200 } }
  });
  fireEvent.click(screen.getByRole("link", { name: "Save and leave" }));
  await waitFor(() => expect(pathname).toBe("/"));

  fireEvent.click(await screen.findByRole("button", { name: /Continue Nishi/ }));
  await waitFor(() => expect(pathname).toBe("/p/nishi/bring-in"));
  const again = await screen.findByRole("region", { name: "Needs you" });
  expect(within(again).getByText("qxzv")).toBeInTheDocument();
});

describe("redirects", () => {
  test.each([
    ["/p/tokyo", "/p/tokyo/set-up"],
    ["/p/shinjuku", "/p/shinjuku/check"],
    ["/p/ueno", "/p/ueno/check"],
    ["/p/ikebukuro", "/p/ikebukuro/check"],
    ["/p/ikebukuro/deliver", "/p/ikebukuro/deliver"],
    ["/p/kanda", "/p/kanda/set-up"],
    ["/p/kanda/check", "/p/kanda/set-up"],
    ["/p/tokyo/check", "/p/tokyo/set-up"],
    ["/p/tokyo/deliver", "/p/tokyo/set-up"],
    ["/p/tokyo/not-a-stage", "/p/tokyo/set-up"],
    ["/p/ueno/set-up", "/p/ueno/check"],
    ["/p/nishi", "/p/nishi/bring-in"],
    ["/p/nishi/check", "/p/nishi/bring-in"]
  ])("%s lands on %s", async (from, to) => {
    renderAt(from);
    await waitFor(() => expect(pathname).toBe(to));
    await sleep(50);
    expect(pathname).toBe(to);
  });

  test("a project with nothing in it lands once and stays", async () => {
    renderAt("/p/empty");
    await waitFor(() => expect(pathname).toBe("/p/empty/set-up"));
    await sleep(100);
    expect(visited).toEqual(["/p/empty", "/p/empty/set-up"]);
  });

  test("a project that fails to load does not redirect or retry on its own", async () => {
    vi.mocked(fetchWizardState).mockRejectedValue(new ApiClientError(500, "INTERNAL", "boom", true));
    renderAt("/p/tokyo");
    expect(await screen.findByText("Could not open this project")).toBeInTheDocument();
    await sleep(100);
    expect(visited).toEqual(["/p/tokyo"]);
    expect(fetchWizardState).toHaveBeenCalledTimes(1);
  });

  test("/wizard and /review go to the project in memory", async () => {
    useAppStore.getState().switchProject("shinjuku");
    renderAt("/wizard");
    await waitFor(() => expect(pathname).toBe("/p/shinjuku/set-up"));
    await screen.findByLabelText(/Venue name/);
    act(() => navigate("/review"));
    await waitFor(() => expect(pathname).toBe("/p/shinjuku/check"));
  });

  test.each(["/wizard", "/review"])("%s with no project in memory goes to /", async (from) => {
    renderAt(from);
    await waitFor(() => expect(pathname).toBe("/"));
    expect(await screen.findByRole("heading", { name: "Station projects" })).toBeInTheDocument();
  });
});

test("a project that is no longer kept opens the dialog, which leads back to /", async () => {
  renderAt("/p/pruned-id/check");
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("This project is no longer kept on this PC");
  fireEvent.click(within(dialog).getByRole("button", { name: "Back to projects" }));
  await waitFor(() => expect(pathname).toBe("/"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(useAppStore.getState().sessionId).toBeNull();
});

describe("switching project in the same tab", () => {
  test("keeps nothing of the previous project", async () => {
    renderAt("/p/ueno/check");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Deliver/ })).toBeEnabled());
    act(() => {
      useAppStore.setState({
        selectedFeatureIds: ["ueno-level"],
        filters: { type: "unit" },
        editHistory: [{ id: "ueno-level" }],
        validationResults: { errors: 4, warnings: 2 },
        wizardDrafts: { project: project("Ueno draft"), buildings: null, footprint: null },
        learningSuggestion: { keyword: "x" } as never
      });
    });

    act(() => navigate("/p/tokyo/set-up"));
    await screen.findByLabelText(/Venue name/);

    const state = useAppStore.getState();
    expect(state.sessionId).toBe("tokyo");
    expect(state.importProfile).toBe("standard");
    expect(state.files.map((item) => item.stem)).toEqual(["Tokyo_B1_Space"]);
    expect(state.wizardState?.project?.venue_name).toBe("Tokyo Station");
    expect(state.selectedFeatureIds).toEqual([]);
    expect(state.filters).toEqual({});
    expect(state.editHistory).toEqual([]);
    expect(state.validationResults).toEqual({ errors: 0, warnings: 0 });
    expect(state.wizardDrafts).toEqual({ project: null, buildings: null, footprint: null });
    expect(state.learningSuggestion).toBeNull();
    expect(state.currentScreen).toBe("wizard");
  });

  test("flushes the pending autosave against the project being left", async () => {
    let releaseSave: () => void = () => {};
    vi.mocked(patchWizardProject).mockImplementation(async (id, payload) => {
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      return { session_id: id, wizard: { ...wizardFor(lookup(id)), project: payload }, address_feature: {} } as never;
    });

    renderAt("/p/tokyo/set-up");
    const venue = await screen.findByLabelText(/Venue name/);
    fireEvent.change(venue, { target: { value: "Tokyo Station East" } });
    await sleep(AUTOSAVE_DELAY_MS / 4);
    expect(patchWizardProject).not.toHaveBeenCalled();

    act(() => navigate("/p/shinjuku/set-up"));

    await waitFor(() => expect(patchWizardProject).toHaveBeenCalledTimes(1));
    const [savedId, payload] = vi.mocked(patchWizardProject).mock.calls[0];
    expect(savedId).toBe("tokyo");
    expect(payload.venue_name).toBe("Tokyo Station East");

    await screen.findByDisplayValue("Shinjuku");
    await act(async () => releaseSave());
    await sleep(20);

    const state = useAppStore.getState();
    expect(state.sessionId).toBe("shinjuku");
    expect(state.wizardState?.project?.venue_name).toBe("Shinjuku");
    expect(state.files.map((item) => item.stem)).toEqual(["Shinjuku_1_Space"]);
    expect(state.wizardSaveStatus).not.toBe("saved");
    expect(screen.getByLabelText(/Venue name/)).toHaveValue("Shinjuku");
  });

  test("Back returns to the first project with its own data", async () => {
    renderAt("/p/tokyo/set-up");
    await screen.findByDisplayValue("Tokyo Station");
    act(() => navigate("/p/shinjuku/check"));
    await waitFor(() => expect(useAppStore.getState().loadedSessionId).toBe("shinjuku"));
    act(() => navigate(-1));
    await screen.findByDisplayValue("Tokyo Station");
    expect(pathname).toBe("/p/tokyo/set-up");
    expect(useAppStore.getState().files.map((item) => item.stem)).toEqual(["Tokyo_B1_Space"]);
  });

  test("a late SESSION_NOT_FOUND for the project left behind does not open the dialog", async () => {
    let rejectSave: (error: unknown) => void = () => {};
    vi.mocked(patchWizardProject).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        })
    );
    renderAt("/p/tokyo/set-up");
    const venue = await screen.findByLabelText(/Venue name/);
    fireEvent.change(venue, { target: { value: "Tokyo Station East" } });
    act(() => navigate("/p/shinjuku/set-up"));
    await waitFor(() => expect(patchWizardProject).toHaveBeenCalledTimes(1));
    await screen.findByDisplayValue("Shinjuku");

    await act(async () => rejectSave(gone("tokyo")));
    await sleep(50);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useAppStore.getState().sessionExpiredMessage).toBeNull();
    expect(useAppStore.getState().sessionId).toBe("shinjuku");
  });
});

describe("history", () => {
  test("closing an export dialog opened from Check, also after Forward, leaves no extra entry", async () => {
    renderAt(["/p/shinjuku/set-up", "/p/shinjuku/check"]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Deliver/ })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /^Deliver/ }));
    await screen.findByRole("dialog");
    expect(pathname).toBe("/p/shinjuku/deliver");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(pathname).toBe("/p/shinjuku/check"));

    act(() => navigate(1));
    await screen.findByRole("dialog");
    expect(pathname).toBe("/p/shinjuku/deliver");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(pathname).toBe("/p/shinjuku/check"));

    act(() => navigate(-1));
    await screen.findByLabelText(/Venue name/);
    expect(pathname).toBe("/p/shinjuku/set-up");
  });

  test("other files start a new project, and Back returns to the old one", async () => {
    vi.mocked(importShapefiles).mockResolvedValue({
      session_id: "kanda",
      import_profile: "standard",
      files: PROJECTS.kanda.files,
      cleanup_summary: {} as never,
      warnings: []
    });
    const { container } = renderAt("/p/tokyo/bring-in");
    fireEvent.click(await screen.findByRole("link", { name: "bring in other files" }));
    await waitFor(() => expect(pathname).toBe("/p/new"));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const parts = [".shp", ".shx", ".dbf"].map((extension) => new File(["shape"], `Kanda_1_Space${extension}`));
    fireEvent.change(input, { target: { files: { ...parts, length: parts.length, item: (index: number) => parts[index] } } });
    const importButton = screen.getAllByRole("button", { name: "Read the files" })[0];
    await waitFor(() => expect(importButton).toBeEnabled());
    fireEvent.click(importButton);

    await waitFor(() => expect(pathname).toBe("/p/kanda/bring-in"));
    await screen.findByText("Kanda_1_Space");

    act(() => navigate(-1));
    await waitFor(() => expect(pathname).toBe("/p/tokyo/bring-in"));
    await waitFor(() => expect(useAppStore.getState().loadedSessionId).toBe("tokyo"));
    expect(useAppStore.getState().files.map((item) => item.stem)).toEqual(["Tokyo_B1_Space"]);
  });
});
