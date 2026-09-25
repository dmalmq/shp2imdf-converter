import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { fetchProjects, importImdf, type ProjectListResponse, type ProjectSummary } from "../api/client";
import { ApiClientError } from "../api/errors";
import { ToastProvider } from "../components/shared/ToastProvider";
import type { DroppedFiles } from "../lib/hub";
import { projectSummary, zipFile } from "../lib/hub.fixtures";
import { useAppStore } from "../store/useAppStore";
import { HubPage } from "./HubPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  fetchProjects: vi.fn(),
  importImdf: vi.fn()
}));

const LIMITS: ProjectListResponse["limits"] = {
  sessions: { idle_days: 30, max_projects: 200 },
  artwork: { idle_days: 30, max_projects: 200 }
};

function listing(projects: ProjectSummary[]): ProjectListResponse {
  return { projects, total: projects.length, limits: LIMITS };
}

function Landed() {
  const location = useLocation();
  const dropped = (location.state as DroppedFiles | null)?.droppedFiles ?? [];
  return (
    <p data-testid="landed">
      {location.pathname}
      {dropped.length > 0 ? ` with ${dropped.map((file) => file.name).join(", ")}` : ""}
    </p>
  );
}

function renderHub() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<HubPage />} />
          <Route path="*" element={<Landed />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

const TOKYO = projectSummary({ id: "tokyo", name: "東京駅", stage: "check", last_opened: "2026-08-18T03:00:00Z" });
const SHINJUKU = projectSummary({
  id: "shinjuku",
  name: "新宿駅",
  stage: "deliver",
  blockers: 0,
  can_wait: 0,
  delivered_at: "2026-09-12T03:00:00Z",
  last_opened: "2026-09-12T03:00:00Z"
});
const IKEBUKURO = projectSummary({
  id: "ikebukuro",
  name: "池袋駅",
  import_profile: "imdf_shapefile",
  stage: "bring-in",
  blockers: null,
  can_wait: null,
  last_opened: "2026-09-02T03:00:00Z"
});

beforeEach(() => {
  vi.mocked(fetchProjects).mockReset();
  vi.mocked(importImdf).mockReset();
  useAppStore.setState({ uiLanguage: "en", sessionId: null });
});

function cards(): HTMLElement[] {
  return [...screen.getByRole("list", { name: "Projects" }).children] as HTMLElement[];
}

test("lists shapefile projects most recently opened first, with each one's stage and status", async () => {
  vi.mocked(fetchProjects).mockResolvedValue(listing([TOKYO, IKEBUKURO, SHINJUKU]));
  renderHub();
  expect(fetchProjects).toHaveBeenCalledWith("shapefiles");

  await screen.findByText("3 projects on this PC · most recently opened first");
  expect(cards().map((card) => within(card).getByRole("heading").textContent)).toEqual(["新宿駅", "池袋駅", "東京駅"]);

  const [shinjuku, ikebukuro, tokyo] = cards();
  expect(shinjuku).toHaveTextContent("Delivered 12 Sep");
  expect(within(shinjuku).getByRole("button", { name: "Open 新宿駅" })).toBeInTheDocument();
  expect(ikebukuro).toHaveTextContent("Stage 1 of 4 · Bring in");
  expect(ikebukuro).toHaveTextContent("IMDF shapefiles → ODC 2026");
  expect(ikebukuro).toHaveTextContent("Not checked yet");
  expect(tokyo).toHaveTextContent("3 things to fix before you can deliver");
  expect(within(tokyo).getByRole("listitem", { current: "step" })).toHaveTextContent("Check");
  expect(screen.getByText("Projects are kept for 30 days after they were last opened.")).toBeInTheDocument();
});

test.each([
  ["東京駅", "Continue 東京駅", "/p/tokyo/check"],
  ["新宿駅", "Open 新宿駅", "/p/shinjuku/deliver"],
  ["池袋駅", "Continue 池袋駅", "/p/ikebukuro"]
])("%s goes to %s's route", async (_name, button, path) => {
  vi.mocked(fetchProjects).mockResolvedValue(listing([TOKYO, IKEBUKURO, SHINJUKU]));
  renderHub();
  fireEvent.click(await screen.findByRole("button", { name: button }));
  expect(await screen.findByTestId("landed")).toHaveTextContent(path);
});

test("filters keep delivered work apart from work in progress", async () => {
  vi.mocked(fetchProjects).mockResolvedValue(listing([TOKYO, SHINJUKU]));
  renderHub();
  await screen.findByRole("button", { name: "Open 新宿駅" });

  fireEvent.click(screen.getByRole("button", { name: "Delivered" }));
  expect(cards().map((card) => within(card).getByRole("heading").textContent)).toEqual(["新宿駅"]);
  fireEvent.click(screen.getByRole("button", { name: "In progress" }));
  expect(cards().map((card) => within(card).getByRole("heading").textContent)).toEqual(["東京駅"]);
});

test("with no projects the hub says so and still offers every route", async () => {
  vi.mocked(fetchProjects).mockResolvedValue(listing([]));
  renderHub();
  expect(await screen.findByText("No projects on this PC yet")).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
  for (const route of [/From floor shapefiles/, /From Illustrator artwork/, /Reopen an IMDF archive/]) {
    expect(screen.getByRole("button", { name: route })).toBeEnabled();
  }
});

test("a failed listing shows the error and tries again on request", async () => {
  vi.mocked(fetchProjects)
    .mockRejectedValueOnce(new ApiClientError(500, "INTERNAL", "Index unreadable", true))
    .mockResolvedValueOnce(listing([TOKYO]));
  renderHub();

  expect(screen.getByLabelText("Loading projects")).toHaveAttribute("aria-busy", "true");
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not load the projects");
  expect(alert).toHaveTextContent("Index unreadable");

  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("heading", { name: "東京駅" })).toBeInTheDocument();
  expect(fetchProjects).toHaveBeenCalledTimes(2);
});

test("the Japanese hub speaks Japanese", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  vi.mocked(fetchProjects).mockResolvedValue(listing([TOKYO]));
  renderHub();
  expect(await screen.findByText("書き出し前に修正が必要な項目 3 件")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "駅プロジェクト" })).toBeInTheDocument();
  expect(screen.getByText("このPCのプロジェクト 1 件 · 最近開いた順")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "新しく始める" })).toBeInTheDocument();
});

describe("the drop zone", () => {
  function drop(files: File[]) {
    fireEvent.change(screen.getByTestId("hub-drop-input"), { target: { files } });
  }

  beforeEach(() => {
    vi.mocked(fetchProjects).mockResolvedValue(listing([]));
  });

  test("shapefile parts go to a new project's Bring in with the files", async () => {
    renderHub();
    drop([new File(["x"], "JRTokyoSta_B1_Space.shp"), new File(["x"], "JRTokyoSta_B1_Space.dbf")]);
    expect(await screen.findByTestId("landed")).toHaveTextContent(
      "/p/new with JRTokyoSta_B1_Space.shp, JRTokyoSta_B1_Space.dbf"
    );
  });

  test("an .ai goes to the artwork flow with the file", async () => {
    renderHub();
    drop([new File(["%PDF"], "0001_東京.ai")]);
    expect(await screen.findByTestId("landed")).toHaveTextContent("/illustrator with 0001_東京.ai");
  });

  test("an IMDF archive is opened through the IMDF import and lands on Check", async () => {
    vi.mocked(importImdf).mockResolvedValue({ session_id: "reopened", feature_count: 12 });
    renderHub();
    const archive = zipFile("export.zip", ["manifest.json", "venue.geojson"]);
    drop([archive]);
    expect(await screen.findByTestId("landed")).toHaveTextContent("/p/reopened/check");
    expect(importImdf).toHaveBeenCalledWith(archive);
    expect(useAppStore.getState().sessionId).toBe("reopened");
  });

  test("files that fit no route are named in a notice, and the rest go on", async () => {
    renderHub();
    drop([new File(["x"], "a.shp"), new File(["x"], "notes.txt")]);
    expect(await screen.findByTestId("landed")).toHaveTextContent("/p/new with a.shp");
    expect(screen.getByText("Some files were left out")).toBeInTheDocument();
    expect(screen.getByText("Not used: notes.txt")).toBeInTheDocument();
  });

  test("a mixed drop is refused with a reason and goes nowhere", async () => {
    renderHub();
    await screen.findByText("No projects on this PC yet");
    drop([new File(["x"], "a.shp"), new File(["x"], "b.ai")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Those files belong to different routes");
    expect(screen.queryByTestId("landed")).toBeNull();
  });
});
