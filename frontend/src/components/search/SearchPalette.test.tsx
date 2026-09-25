import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchProjects } from "../../api/client";
import { buildFloorGroups } from "../review/floorGroups";
import type { ReviewFeature } from "../review/types";
import { ToastProvider } from "../shared/ToastProvider";
import { AppShell } from "../shell/AppShell";
import { buildCheckView } from "../../lib/check";
import type { ApplyOutcome, CheckSource } from "../../lib/search/source";
import { useAppStore } from "../../store/useAppStore";
import { useSearchSource } from "./SearchContext";

vi.mock("../../api/client", async (original) => ({
  ...(await original<typeof import("../../api/client")>()),
  fetchProjects: vi.fn()
}));

const FEATURES: ReviewFeature[] = [
  { type: "Feature", id: "l0", feature_type: "level", geometry: null, properties: { name: { ja: "屋外" }, short_name: { ja: "0F" }, ordinal: 0 } },
  { type: "Feature", id: "l1", feature_type: "level", geometry: null, properties: { name: { ja: "1F" }, short_name: { ja: "1F" }, ordinal: 1 } },
  { type: "Feature", id: "u1", feature_type: "unit", geometry: null, properties: { level_id: "l0" } }
];

function checkSource(apply: CheckSource["apply"], showPreview = vi.fn()): CheckSource {
  const floors = buildFloorGroups(FEATURES);
  return {
    snapshot: {
      sessionId: "s1",
      contentRev: 4,
      features: FEATURES,
      validation: null,
      view: buildCheckView(null, FEATURES, floors),
      floors,
      language: "ja"
    },
    openIssue: vi.fn(),
    showFloor: vi.fn(),
    showLevel: vi.fn(),
    runChecks: vi.fn(),
    showPreview,
    apply
  };
}

function Lends({ source }: { source: CheckSource }) {
  useSearchSource(source);
  return null;
}

function renderShell(children: React.ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </MemoryRouter>
  );
}

const box = () => screen.getByRole("combobox");

beforeEach(() => {
  vi.mocked(fetchProjects).mockReset();
  vi.mocked(fetchProjects).mockResolvedValue({
    projects: [],
    total: 0,
    limits: { sessions: { idle_days: 30, max_projects: 200 }, artwork: { idle_days: 30, max_projects: 200 } }
  });
  useAppStore.setState({ uiLanguage: "en" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchPalette", () => {
  it("opens on Ctrl K from inside another input, and the browser's own Ctrl K never fires", () => {
    renderShell(<input aria-label="Venue name" />);
    const venue = screen.getByRole("textbox", { name: "Venue name" });
    venue.focus();

    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      venue.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(box()).toHaveFocus();
    expect(box()).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveAttribute("aria-expanded", "false");
    expect(venue).toHaveFocus();
  });

  it("ignores Enter while a composition is open, and the Enter that confirms it", () => {
    renderShell();
    fireEvent.change(box(), { target: { value: "日本語" } });

    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(useAppStore.getState().uiLanguage).toBe("en");

    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(useAppStore.getState().uiLanguage).toBe("ja");
  });

  it("closes on a click on the map without that click also selecting a feature", async () => {
    const select = vi.fn();
    renderShell(<div className="maplibregl-map" data-testid="map" onClick={select} />);
    act(() => {
      box().focus();
    });
    expect(box()).toHaveAttribute("aria-expanded", "true");

    const map = screen.getByTestId("map");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(map);
    fireEvent.click(map);

    await waitFor(() => expect(box()).toHaveAttribute("aria-expanded", "false"));
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(map);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("previews a typed command, outlines it, and applies it at the revision it was read at", async () => {
    const apply = vi.fn(async (): Promise<ApplyOutcome> => ({ kind: "done" }));
    const showPreview = vi.fn();
    renderShell(<Lends source={checkSource(apply, showPreview)} />);

    act(() => {
      box().focus();
    });
    fireEvent.change(box(), { target: { value: "assign 屋外 to 1F outdoor" } });

    expect(
      await screen.findByText("Move the 屋外 level onto floor 1F and mark it as outdoor.", { selector: "p" })
    ).toBeInTheDocument();
    expect(screen.getByText("level 屋外 (now on 0F)")).toBeInTheDocument();
    expect(showPreview).toHaveBeenLastCalledWith(["l0", "u1"]);

    fireEvent.keyDown(box(), { key: "Enter" });

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]).toEqual([expect.objectContaining({ verb: "assign", outdoor: "set" }), 4]);
    await waitFor(() => expect(box()).toHaveAttribute("aria-expanded", "false"));
    expect(showPreview).toHaveBeenLastCalledWith(null);
  });

  it("says so when the project moved on, and keeps the preview", async () => {
    const apply = vi.fn(async (): Promise<ApplyOutcome> => ({ kind: "stale" }));
    renderShell(<Lends source={checkSource(apply)} />);
    act(() => {
      box().focus();
    });
    fireEvent.change(box(), { target: { value: "assign 屋外 to 1F" } });
    fireEvent.click(await screen.findByRole("button", { name: /Apply/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This changed since you looked");
    expect(box()).toHaveAttribute("aria-expanded", "true");
  });

  it("offers each of two same-named levels as a completion that Tab fills in", async () => {
    renderShell(<Lends source={checkSource(vi.fn())} />);
    act(() => {
      box().focus();
    });
    fireEvent.change(box(), { target: { value: "assign 屋" } });
    fireEvent.keyDown(box(), { key: "Tab" });

    expect(box()).toHaveValue("assign 屋外 to ");
  });

  it("asks the listing only, and only when it opens", async () => {
    renderShell();
    expect(fetchProjects).not.toHaveBeenCalled();
    act(() => {
      box().focus();
    });
    fireEvent.change(box(), { target: { value: "東京駅 1F" } });
    fireEvent.change(box(), { target: { value: "overlap" } });
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(1));
    expect(fetchProjects).toHaveBeenCalledWith("shapefiles");
  });
});
