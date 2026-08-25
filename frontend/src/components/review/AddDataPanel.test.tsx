import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  commitSessionImport,
  discardStagedImport,
  fetchStagedFeatures,
  listImportBatches,
  restageSessionImport,
  stageSessionImport,
  undoImportBatch,
  type AppendCandidateFeature,
  type AppendStageResponse
} from "../../api/client";
import { ToastProvider } from "../shared/ToastProvider";
import { AddDataPanel } from "./AddDataPanel";

vi.mock("../../api/client", () => ({
  commitSessionImport: vi.fn(),
  discardStagedImport: vi.fn(),
  fetchStagedFeatures: vi.fn(),
  listImportBatches: vi.fn(),
  restageSessionImport: vi.fn(),
  stageSessionImport: vi.fn(),
  undoImportBatch: vi.fn()
}));

const stageMock = vi.mocked(stageSessionImport);
const commitMock = vi.mocked(commitSessionImport);
const restageMock = vi.mocked(restageSessionImport);
const discardMock = vi.mocked(discardStagedImport);
const listBatchesMock = vi.mocked(listImportBatches);
const undoMock = vi.mocked(undoImportBatch);
const featuresMock = vi.mocked(fetchStagedFeatures);

const HOST_B1 = { id: "level-b1", name: "B1F", short_name: "B1F", ordinal: -1, label: "B1F" };
const HOST_1F = { id: "level-1f", name: "1F", short_name: "1F", ordinal: 0, label: "1F" };

function makePlan(overrides: Partial<AppendStageResponse> = {}): AppendStageResponse {
  return {
    session_id: "session-1",
    batch_id: "batch-1",
    profile: "imdf_shapefile",
    files: [
      {
        stem: "Demo_B1_Opening",
        geometry_type: "LineString",
        feature_count: 4,
        detected_type: "opening",
        detected_level: -1,
        level_name: null,
        short_name: null,
        outdoor: false,
        level_category: "unspecified",
        confidence: "green",
        source_format: "shapefile",
        attribute_columns: ["TYPE", "NAME"],
        warnings: []
      }
    ],
    levels: [
      {
        candidate_level_id: "candidate-1",
        name: "B1F",
        short_name: "B1F",
        ordinal: -1,
        label: "B1F",
        feature_count: 4,
        match_basis: "name",
        host_level_id: HOST_B1.id,
        host_level_options: []
      }
    ],
    host_levels: [HOST_B1, HOST_1F],
    feature_counts: { opening: 4 },
    id_collisions: 0,
    id_collision_sample: [],
    needs_decisions: false,
    needs_mapping: false,
    alignment: null,
    mappings: null,
    cleanup_summary: {
      multipolygons_exploded: 0,
      rings_closed: 0,
      features_reoriented: 0,
      empty_features_dropped: 0,
      coordinates_rounded: 0
    },
    warnings: [],
    ...overrides
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof AddDataPanel>> = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <AddDataPanel
        sessionId="session-1"
        importProfile="imdf_shapefile"
        onClose={onClose}
        onChanged={onChanged}
        {...props}
      />
    </ToastProvider>
  );
  return { onClose, onChanged };
}

async function stageAFile(plan: AppendStageResponse) {
  stageMock.mockResolvedValue(plan);
  const input = screen.getByLabelText("Files") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "Demo_B1_Opening.shp", { type: "application/octet-stream" })] }
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getByText("Floors")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  listBatchesMock.mockResolvedValue([]);
  // No candidate rows by default: the whole batch comes in and the selection
  // panel stays out of the way.
  featuresMock.mockRejectedValue(new Error("not stubbed"));
});

describe("AddDataPanel", () => {
  it("does not commit anything until the plan is confirmed", async () => {
    renderPanel();
    await stageAFile(makePlan());

    expect(stageMock).toHaveBeenCalledWith(
      "session-1",
      expect.any(Array),
      "imdf_shapefile",
      expect.any(Function),
      false
    );
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("pre-selects the matched floor and sends it on commit", async () => {
    const { onChanged, onClose } = renderPanel();
    await stageAFile(makePlan());

    const select = screen.getByLabelText("Where to put B1F") as HTMLSelectElement;
    expect(select.value).toBe("bind:level-b1");

    commitMock.mockResolvedValue({
      session_id: "session-1",
      batch_id: "batch-1",
      added_features: 4,
      feature_counts: { opening: 4 },
      bound_levels: { "candidate-1": "level-b1" },
      created_level_ids: [],
      rejected_level_ids: [],
      dropped_features: 1,
      reminted_ids: 0,
      replaced_ids: 0,
      total_features: 40,
      warnings: []
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));

    await waitFor(() => expect(commitMock).toHaveBeenCalled());
    expect(commitMock).toHaveBeenCalledWith("session-1", {
      batch_id: "batch-1",
      level_decisions: [
        { candidate_level_id: "candidate-1", action: "bind", host_level_id: "level-b1" }
      ],
      on_id_collision: "remint",
      selection: null,
      apply_alignment: false
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("will not commit while a floor has no answer", async () => {
    renderPanel();
    await stageAFile(
      makePlan({
        needs_decisions: true,
        levels: [
          {
            candidate_level_id: "candidate-2",
            name: "2F",
            short_name: "2F",
            ordinal: 1,
            label: "2F",
            feature_count: 9,
            match_basis: "unmatched",
            host_level_id: null,
            host_level_options: []
          }
        ]
      })
    );

    const commitButton = screen.getByRole("button", { name: "Add to dataset" });
    expect(commitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Where to put 2F"), { target: { value: "create" } });
    expect(commitButton).toBeEnabled();

    commitMock.mockResolvedValue({
      session_id: "session-1",
      batch_id: "batch-1",
      added_features: 9,
      feature_counts: {},
      bound_levels: {},
      created_level_ids: ["candidate-2"],
      rejected_level_ids: [],
      dropped_features: 0,
      reminted_ids: 0,
      replaced_ids: 0,
      total_features: 49,
      warnings: []
    });
    fireEvent.click(commitButton);
    await waitFor(() => expect(commitMock).toHaveBeenCalled());
    expect(commitMock.mock.calls[0][1].level_decisions).toEqual([
      { candidate_level_id: "candidate-2", action: "create" }
    ]);
  });

  it("makes an ambiguous floor a choice between the levels that tied", async () => {
    renderPanel();
    await stageAFile(
      makePlan({
        needs_decisions: true,
        levels: [
          {
            candidate_level_id: "candidate-3",
            name: null,
            short_name: "2F",
            ordinal: 1,
            label: "2F",
            feature_count: 3,
            match_basis: "ambiguous",
            host_level_id: null,
            host_level_options: [HOST_B1, HOST_1F]
          }
        ]
      })
    );

    expect(screen.getByText(/Several floors match this one/)).toBeInTheDocument();
    const select = screen.getByLabelText("Where to put 2F") as HTMLSelectElement;
    expect(select.value).toBe("");
    const optionLabels = [...select.options].map((option) => option.textContent);
    expect(optionLabels).toContain("Add to B1F");
    expect(optionLabels).toContain("Add to 1F");
  });

  it("warns about repeated ids and defaults to keeping both", async () => {
    renderPanel();
    await stageAFile(makePlan({ id_collisions: 2, id_collision_sample: ["a", "b"] }));

    expect(screen.getByText(/2 incoming feature\(s\) use an id/)).toBeInTheDocument();
    const policy = screen.getByLabelText("Repeated ids") as HTMLSelectElement;
    expect(policy.value).toBe("remint");

    fireEvent.change(policy, { target: { value: "replace" } });
    commitMock.mockResolvedValue({
      session_id: "session-1",
      batch_id: "batch-1",
      added_features: 4,
      feature_counts: {},
      bound_levels: {},
      created_level_ids: [],
      rejected_level_ids: [],
      dropped_features: 0,
      reminted_ids: 0,
      replaced_ids: 2,
      total_features: 40,
      warnings: []
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
    await waitFor(() => expect(commitMock).toHaveBeenCalled());
    expect(commitMock.mock.calls[0][1].on_id_collision).toBe("replace");
  });

  it("offers no category column for a profile that cannot be re-mapped", async () => {
    renderPanel();
    await stageAFile(makePlan({ profile: "imdf_shapefile" }));

    // These readers take categories from the source fields, and the backend
    // rejects a re-stage for them.
    expect(screen.queryByLabelText("Category column")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("re-reads the batch when the category column changes", async () => {
    renderPanel({ importProfile: "standard" });
    const plan = makePlan({
      profile: "standard",
      needs_mapping: true,
      mappings: {
        unit: {
          code_column: null,
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
      }
    });
    await stageAFile(plan);

    expect(screen.getByText(/No category column is set/)).toBeInTheDocument();

    const restaged = makePlan({
      profile: "standard",
      needs_mapping: false,
      mappings: { ...plan.mappings!, unit: { ...plan.mappings!.unit, code_column: "TYPE" } }
    });
    restageMock.mockResolvedValue(restaged);

    fireEvent.change(screen.getByLabelText("Category column"), { target: { value: "TYPE" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(restageMock).toHaveBeenCalled());
    expect(restageMock.mock.calls[0][2].mappings?.unit.code_column).toBe("TYPE");
    await waitFor(() => expect(screen.queryByText(/No category column is set/)).not.toBeInTheDocument());
  });

  it("discards the staged batch when cancelled after reading files", async () => {
    const { onClose } = renderPanel();
    await stageAFile(makePlan());

    discardMock.mockResolvedValue();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(discardMock).toHaveBeenCalledWith("session-1", "batch-1"));
    expect(onClose).toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("lists already-added batches and can undo one", async () => {
    listBatchesMock.mockResolvedValue([
      {
        batch_id: "batch-old",
        profile: "imdf_shapefile",
        committed_at: "2026-08-25T00:00:00Z",
        file_stems: ["Demo_2F_Space"],
        feature_count: 12,
        created_level_ids: [],
        warnings: []
      }
    ]);
    const { onChanged } = renderPanel();
    await waitFor(() => expect(screen.getByText("Demo_2F_Space")).toBeInTheDocument());

    undoMock.mockResolvedValue({
      session_id: "session-1",
      batch_id: "batch-old",
      removed_features: 12,
      removed_source_rows: 12,
      removed_files: ["Demo_2F_Space"],
      total_features: 28
    });
    listBatchesMock.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(undoMock).toHaveBeenCalledWith("session-1", "batch-old"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  describe("choosing part of a batch", () => {
    const ROWS: AppendCandidateFeature[] = [
      {
        id: "u1",
        feature_type: "unit",
        stem: "Demo_B1_Space",
        source_row_index: 0,
        name: "Shop A",
        category: "B001",
        level_id: null,
        level_label: null,
        point: [139.7, 35.68],
        geometry: null,
        attributes: { category: "B001" },
        already_imported: false
      },
      {
        id: "u2",
        feature_type: "unit",
        stem: "Demo_B1_Space",
        source_row_index: 1,
        name: "Store room",
        category: "B019",
        level_id: null,
        level_label: null,
        point: [139.701, 35.68],
        geometry: null,
        attributes: { category: "B019" },
        already_imported: false
      },
      {
        id: "o1",
        feature_type: "opening",
        stem: "Demo_B1_Opening",
        source_row_index: 0,
        name: "Door",
        category: "pedestrian",
        level_id: null,
        level_label: null,
        point: [139.702, 35.68],
        geometry: null,
        attributes: {},
        already_imported: false
      }
    ];

    async function stageWithRows(rows: AppendCandidateFeature[] = ROWS) {
      featuresMock.mockResolvedValue({
        session_id: "session-1",
        batch_id: "batch-1",
        features: rows,
        columns_by_stem: { Demo_B1_Space: ["category"], Demo_B1_Opening: [] }
      });
      await stageAFile(makePlan());
      await waitFor(() => expect(screen.getByTestId("selection-summary")).toBeInTheDocument());
    }

    function commitResult() {
      return {
        session_id: "session-1",
        batch_id: "batch-1",
        added_features: 1,
        feature_counts: {},
        bound_levels: {},
        created_level_ids: [],
        rejected_level_ids: [],
        dropped_features: 0,
        alignment_applied: null,
        deselected_features: 2,
        skipped_already_imported: 0,
        reminted_ids: 0,
        replaced_ids: 0,
        total_features: 41,
        warnings: []
      };
    }

    it("starts with everything chosen and sends no selection", async () => {
      renderPanel();
      await stageWithRows();

      expect(screen.getByTestId("selection-summary")).toHaveTextContent("3 / 3 selected");

      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      // Nothing narrowed down, so the batch is taken whole.
      expect(commitMock.mock.calls[0][1].selection).toBeNull();
    });

    it("narrows by feature type and sends what it narrowed to", async () => {
      renderPanel();
      await stageWithRows();

      fireEvent.click(screen.getByRole("tab", { name: "Filters" }));
      fireEvent.click(screen.getByLabelText("opening"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("2 / 3 selected");

      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      expect(commitMock.mock.calls[0][1].selection?.feature_types).toEqual(["unit"]);
    });

    it("filters a layer by an attribute value, with counts", async () => {
      renderPanel();
      await stageWithRows();

      fireEvent.click(screen.getByRole("tab", { name: "Filters" }));
      fireEvent.change(screen.getByLabelText("Demo_B1_Space filter column"), {
        target: { value: "category" }
      });
      // Both values start ticked, so the filter changes nothing on its own.
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("3 / 3 selected");

      fireEvent.click(screen.getByLabelText("category B019"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("2 / 3 selected");

      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      expect(commitMock.mock.calls[0][1].selection?.layers).toContainEqual({
        stem: "Demo_B1_Space",
        included: true,
        filter_column: "category",
        filter_values: ["B001"]
      });
    });

    it("lets a single feature be ticked off in the feature list", async () => {
      renderPanel();
      await stageWithRows();

      fireEvent.click(screen.getByRole("tab", { name: "Features" }));
      fireEvent.click(screen.getByLabelText("Store room"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("2 / 3 selected");

      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      expect(commitMock.mock.calls[0][1].selection?.excluded_feature_ids).toEqual(["u2"]);
    });

    it("narrows by floor and category without leaving the map", async () => {
      renderPanel();
      await stageWithRows([
        { ...ROWS[0], level_id: "lvl-b1", level_label: "B1F", category: "retail" },
        { ...ROWS[1], level_id: "lvl-b2", level_label: "B2F", category: "storage" },
        { ...ROWS[2], level_id: "lvl-b2", level_label: "B2F", category: "pedestrian" }
      ]);

      // The map is what opens, and the axes sit above it rather than behind a tab.
      expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute("aria-selected", "true");

      // Clicking a floor narrows to it rather than away from it.
      fireEvent.click(screen.getByLabelText("Floors B2F"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("2 / 3 selected");

      // Category narrows within that floor.
      fireEvent.click(screen.getByLabelText("Categories storage"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("1 / 3 selected");

      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      expect(commitMock.mock.calls[0][1].selection?.level_ids).toEqual(["lvl-b2"]);
      expect(commitMock.mock.calls[0][1].selection?.categories).toEqual(["storage"]);
    });

    it("switching to 'only what I pick' starts empty and commits just the picks", async () => {
      renderPanel();
      await stageWithRows();
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("3 / 3 selected");

      fireEvent.click(screen.getByLabelText("Only what I pick"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("0 / 3 selected");
      expect(screen.getByRole("button", { name: "Add to dataset" })).toBeDisabled();

      fireEvent.click(screen.getByRole("tab", { name: "Features" }));
      fireEvent.click(screen.getByLabelText("Shop A"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("1 / 3 selected");

      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      const sent = commitMock.mock.calls[0][1].selection;
      expect(sent?.base).toBe("picked");
      expect(sent?.included_feature_ids).toEqual(["u1"]);
    });

    it("changing the starting point clears what was chosen under the old one", async () => {
      renderPanel();
      await stageWithRows();

      // Deselect one under the default, then switch: the exclusion must not
      // survive as an inclusion, which would invert the result.
      fireEvent.click(screen.getByRole("tab", { name: "Features" }));
      fireEvent.click(screen.getByLabelText("Store room"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("2 / 3 selected");

      fireEvent.click(screen.getByLabelText("Only what I pick"));
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("0 / 3 selected");
    });

    it("only asks about the floors the selection touches, and counts them", async () => {
      renderPanel();
      // Two floors in the batch; the plan asks about both by default.
      featuresMock.mockResolvedValue({
        session_id: "session-1",
        batch_id: "batch-1",
        features: [
          { ...ROWS[0], level_id: "cand-b1", level_label: "B1F" },
          { ...ROWS[1], level_id: "cand-b1", level_label: "B1F" },
          { ...ROWS[2], level_id: "cand-2f", level_label: "2F" }
        ],
        columns_by_stem: {}
      });
      await stageAFile(
        makePlan({
          needs_decisions: true,
          levels: [
            {
              candidate_level_id: "cand-b1",
              name: "B1F", short_name: "B1F", ordinal: -1, label: "B1F",
              feature_count: 9999,
              match_basis: "name", host_level_id: HOST_B1.id, host_level_options: []
            },
            {
              candidate_level_id: "cand-2f",
              name: "2F", short_name: "2F", ordinal: 1, label: "2F",
              feature_count: 8888,
              match_basis: "unmatched", host_level_id: null, host_level_options: []
            }
          ]
        })
      );
      await waitFor(() => expect(screen.getByTestId("selection-summary")).toBeInTheDocument());

      // Pick one B1F room: 2F is not touched, so it must not be asked about at
      // all — and the count shown is the pick, not the batch's 9999.
      fireEvent.click(screen.getByLabelText("Only what I pick"));
      fireEvent.click(screen.getByRole("tab", { name: "Features" }));
      fireEvent.click(screen.getByLabelText("Shop A"));

      expect(screen.getByLabelText("Where to put B1F")).toBeInTheDocument();
      expect(screen.queryByLabelText("Where to put 2F")).not.toBeInTheDocument();
      expect(screen.getByText(/1 features/)).toBeInTheDocument();

      // And the commit is not blocked by the floor nobody chose anything from.
      commitMock.mockResolvedValue(commitResult());
      fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
      await waitFor(() => expect(commitMock).toHaveBeenCalled());
      expect(commitMock.mock.calls[0][1].level_decisions).toEqual([
        { candidate_level_id: "cand-b1", action: "bind", host_level_id: "level-b1" }
      ]);
    });

    it("offers to close a measured gap, and says how it was measured", async () => {
      renderPanel();
      await stageWithRows();
      // No gap on this plan, so nothing is offered.
      expect(screen.queryByLabelText("Shift to match the existing data")).not.toBeInTheDocument();
    });

    it("will not commit when nothing is selected", async () => {
      renderPanel();
      await stageWithRows();

      fireEvent.click(screen.getByRole("tab", { name: "Features" }));
      fireEvent.click(screen.getByRole("button", { name: "Select none" }));

      expect(screen.getByTestId("selection-summary")).toHaveTextContent("0 / 3 selected");
      expect(screen.getByRole("button", { name: "Add to dataset" })).toBeDisabled();
    });

    it("shows rows the session already holds as already in, and will not take them", async () => {
      renderPanel();
      await stageWithRows([{ ...ROWS[0], already_imported: true }, ROWS[1], ROWS[2]]);

      expect(screen.getByTestId("selection-summary")).toHaveTextContent("2 / 2 selected");
      expect(screen.getByTestId("selection-summary")).toHaveTextContent("1 already in");

      fireEvent.click(screen.getByRole("tab", { name: "Features" }));
      expect(screen.getByLabelText("Shop A")).toBeDisabled();
    });
  });
});

describe("AddDataPanel alignment", () => {
  const ALIGNED = {
    offset_lon: 0.0000084,
    offset_lat: 0.0000032,
    east_metres: 0.76,
    north_metres: 0.35,
    distance_metres: 0.837,
    sample_count: 51,
    spread_cm: 0.2,
    consistent: true,
    from_session: false
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listBatchesMock.mockResolvedValue([]);
    featuresMock.mockRejectedValue(new Error("not stubbed"));
  });

  it("ticks the shift on by default when the gap is a constant one", async () => {
    renderPanel();
    await stageAFile(makePlan({ alignment: ALIGNED }));

    const box = screen.getByLabelText("Shift to match the existing data") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(/0\.84 m from the data already here/)).toBeInTheDocument();
    expect(screen.getByText(/51 features present in both/)).toBeInTheDocument();
    expect(screen.getByText(/consistent to 0\.2 cm/)).toBeInTheDocument();

    commitMock.mockResolvedValue({
      session_id: "session-1", batch_id: "batch-1", added_features: 4, feature_counts: {},
      bound_levels: {}, created_level_ids: [], rejected_level_ids: [], dropped_features: 0,
      alignment_applied: ALIGNED, deselected_features: 0, skipped_already_imported: 0,
      reminted_ids: 0, replaced_ids: 0, total_features: 40, warnings: []
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
    await waitFor(() => expect(commitMock).toHaveBeenCalled());
    expect(commitMock.mock.calls[0][1].apply_alignment).toBe(true);
  });

  it("leaves an inconsistent gap unticked and says a shift will not fix it", async () => {
    renderPanel();
    await stageAFile(
      makePlan({ alignment: { ...ALIGNED, consistent: false, spread_cm: 640.2 } })
    );

    const box = screen.getByLabelText("Shift to match the existing data") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/not the same everywhere/)).toBeInTheDocument();
  });
});
