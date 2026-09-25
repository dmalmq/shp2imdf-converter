import { act, renderHook } from "@testing-library/react";

import { saveIllustratorDraft, type PlacementDraft } from "../api/client";
import type * as ApiClient from "../api/client";
import { buildApiClientError } from "../api/errors";
import { useDraftAutosave } from "./useDraftAutosave";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  saveIllustratorDraft: vi.fn()
}));

const save = vi.mocked(saveIllustratorDraft);

function draft(rotation: number): PlacementDraft {
  return {
    version: 1,
    placement: {
      frame: { rotation_deg: rotation, metres_per_point: 0.35, working_crs: "EPSG:6677" },
      floors: [
        {
          label: "1F",
          linked: true,
          pinned: false,
          artwork_anchor: [0, 0],
          map_anchor: [139.7, 35.6],
          artwork_bounds: [0, 0, 1, 1],
          rotation_deg: null,
          metres_per_point: null,
          artwork_match: false,
          control_points: []
        }
      ],
      scale_locked: true,
      output_crs: "EPSG:6677",
      formats: { geopackage: false, shapefile: true, qgis: false }
    },
    view: {
      active_floor_label: "1F",
      mode: "group",
      tab: "fit",
      station_pin: null,
      location: null,
      references: { preloaded: false, include_lines: false, hidden: [], removed: [], uploads: [] }
    }
  };
}

const PROJECT = {
  name: "sample",
  updated_at: null,
  content_changed_at: null,
  delivered_at: null,
  floors_total: 1,
  floors_placed: 0,
  stage: "place" as const,
  blockers: 1
};

beforeEach(() => {
  vi.useFakeTimers();
  save.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function reorder(value: PlacementDraft): PlacementDraft {
  const { view, placement, version } = value;
  return { view, placement, version };
}

test("opening a saved draft sends nothing", async () => {
  const saved = draft(10);
  const { result } = renderHook(({ current }) => useDraftAutosave(current, { conversionId: "c1", revision: 3, saved }), {
    initialProps: { current: reorder(draft(10)) }
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(save).not.toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
});

test("a change is saved once, debounced, on the revision it builds on", async () => {
  save.mockResolvedValue({ revision: 4, changed: true, project: PROJECT });
  const { rerender, result } = renderHook(
    ({ current }) => useDraftAutosave(current, { conversionId: "c1", revision: 3, saved: draft(10) }),
    { initialProps: { current: draft(10) } }
  );
  rerender({ current: draft(11) });
  rerender({ current: draft(12) });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith("c1", 3, draft(12), { keepalive: false });
  expect(result.current.status).toBe("saved");

  rerender({ current: draft(13) });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(save).toHaveBeenLastCalledWith("c1", 4, draft(13), { keepalive: false });
});

test("a conflict stops saving", async () => {
  save.mockRejectedValue(buildApiClientError(409, JSON.stringify({ detail: "x", code: "DRAFT_CONFLICT" })));
  const { rerender, result } = renderHook(
    ({ current }) => useDraftAutosave(current, { conversionId: "c1", revision: 3, saved: draft(10) }),
    { initialProps: { current: draft(11) } }
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.current.status).toBe("conflict");
  rerender({ current: draft(12) });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(save).toHaveBeenCalledTimes(1);
});

test("nothing is saved until a conversion is tracked, then the new assignment's draft is", async () => {
  save.mockResolvedValue({ revision: 2, changed: true, project: PROJECT });
  const { result } = renderHook(() => useDraftAutosave(draft(0)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(save).not.toHaveBeenCalled();

  act(() => result.current.track("c2", 1, null));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(save).toHaveBeenCalledWith("c2", 1, draft(0), { keepalive: false });
});

test("an unsaved change goes out with keepalive when the page is hidden", async () => {
  save.mockResolvedValue({ revision: 4, changed: true, project: PROJECT });
  const { rerender } = renderHook(
    ({ current }) => useDraftAutosave(current, { conversionId: "c1", revision: 3, saved: draft(10) }),
    { initialProps: { current: draft(10) } }
  );
  rerender({ current: draft(11) });
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(save).toHaveBeenCalledWith("c1", 3, draft(11), { keepalive: true });
});
