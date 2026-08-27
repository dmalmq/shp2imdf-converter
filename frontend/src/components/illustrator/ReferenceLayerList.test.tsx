import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureCollection } from "geojson";

import { uploadReferenceLayers } from "../../api/client";
import type * as ApiClient from "../../api/client";
import { buildApiClientError } from "../../api/errors";
import type { ReferenceLayer } from "./PlacementMap";
import { nextMatchTarget, nextMatchTargetName, ReferenceLayerList } from "./ReferenceLayerList";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  uploadReferenceLayers: vi.fn()
}));

const upload = vi.mocked(uploadReferenceLayers);

const FOCUS = [139.7, 35.69, 139.71, 35.7] as [number, number, number, number];

function features(n: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: n }, (_, i) => ({
      type: "Feature",
      properties: null,
      geometry: { type: "Point", coordinates: [139.7 + i / 1000, 35.69] }
    }))
  };
}

function layer(name: string, total: number, kept: number) {
  return {
    name,
    crs: null,
    feature_count: total,
    truncated: false,
    warnings: [],
    geojson: features(kept)
  };
}

function addFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "station.shp")] } });
}

beforeEach(() => {
  upload.mockReset();
});

/** The component is controlled, so the count rows only appear via a stateful parent. */
function ListHarness({
  focusBounds
}: {
  focusBounds?: [number, number, number, number] | null;
}) {
  const [layers, setLayers] = useState<ReferenceLayer[]>([]);
  const [matchTargetName, setMatchTargetName] = useState("");
  const update = (next: ReferenceLayer[]) => {
    setLayers(next);
    setMatchTargetName((current) => nextMatchTargetName(next, current));
  };
  return (
    <ReferenceLayerList
      layers={layers}
      onChange={update}
      matchTargetName={matchTargetName}
      onMatchTargetChange={setMatchTargetName}
      focusBounds={focusBounds}
    />
  );
}

test("keeps the current match target, auto-selects a single layer, and otherwise clears", () => {
  expect(nextMatchTargetName([{ name: "station" }], "")).toBe("station");
  expect(
    nextMatchTargetName([{ name: "station" }, { name: "parcels" }], "station")
  ).toBe("station");
  expect(nextMatchTargetName([{ name: "parcels" }, { name: "roads" }], "station")).toBe("");
  expect(nextMatchTargetName([{ name: "parcels" }], "station")).toBe("parcels");
  expect(nextMatchTargetName([], "station")).toBe("");
});

test("keeps a floor target, auto-selects the only other floor, and prefers a single shapefile", () => {
  const empty = { referenceName: "", referenceFloorLabel: "" };
  expect(nextMatchTarget([], ["1F", "2F"], "1F", empty)).toEqual({
    referenceName: "",
    referenceFloorLabel: "2F"
  });
  expect(
    nextMatchTarget([], ["1F", "2F", "3F"], "1F", { ...empty, referenceFloorLabel: "2F" })
  ).toEqual({ referenceName: "", referenceFloorLabel: "2F" });
  expect(
    nextMatchTarget([], ["1F", "2F", "3F"], "2F", { ...empty, referenceFloorLabel: "2F" })
  ).toEqual(empty);
  expect(
    nextMatchTarget([{ name: "station" }], ["1F", "2F", "3F"], "1F", empty)
  ).toEqual({ referenceName: "station", referenceFloorLabel: "" });
  expect(
    nextMatchTarget([{ name: "station" }], ["1F", "2F"], "1F", {
      referenceName: "",
      referenceFloorLabel: "2F"
    })
  ).toEqual({ referenceName: "", referenceFloorLabel: "2F" });
});

test("shows the kept count over the source total when a spatial trim happened", async () => {
  upload.mockResolvedValue([layer("station", 12139, 842)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();

  await waitFor(() => expect(screen.getByText("842 / 12139")).toBeInTheDocument());
  // The trim is announced up front, so the count is not a surprise.
  expect(screen.getByText(/trimmed to about 1 km/i)).toBeInTheDocument();
});

test("prints the plain total when nothing was trimmed", async () => {
  upload.mockResolvedValue([layer("station", 12139, 12139)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();

  await waitFor(() => expect(screen.getByText("12139")).toBeInTheDocument());
  expect(screen.queryByText("12139 / 12139")).toBeNull();
});

test("a zero-feature response says nothing was found instead of adding a ghost layer", async () => {
  upload.mockResolvedValue([layer("station", 0, 0)]);
  const onChange = vi.fn();

  render(
    <ReferenceLayerList
      layers={[]}
      onChange={onChange}
      matchTargetName=""
      onMatchTargetChange={() => {}}
      focusBounds={FOCUS}
    />
  );
  addFile();

  await waitFor(() =>
    expect(screen.getByText(/nothing was found near the artwork/i)).toBeInTheDocument()
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByText("station")).toBeNull();
});

test("a stopped backend is reported as unreachable, not as a corrupt file", async () => {
  // The dev proxy answers a refused connection with a bodiless 500.
  upload.mockRejectedValue(buildApiClientError(500, ""));

  render(
    <ReferenceLayerList
      layers={[]}
      onChange={() => {}}
      matchTargetName=""
      onMatchTargetChange={() => {}}
    />
  );
  addFile();

  await waitFor(() => expect(screen.getByText(/could not reach the converter/i)).toBeInTheDocument());
  expect(screen.queryByText(/Could not read that file/i)).toBeNull();
});

test("a real API error message is shown verbatim", async () => {
  upload.mockRejectedValue(
    buildApiClientError(
      422,
      JSON.stringify({ detail: "Not a readable shapefile.", code: "REFERENCE_LAYER_INVALID" })
    )
  );

  render(
    <ReferenceLayerList
      layers={[]}
      onChange={() => {}}
      matchTargetName=""
      onMatchTargetChange={() => {}}
    />
  );
  addFile();

  await waitFor(() => expect(screen.getByText("Not a readable shapefile.")).toBeInTheDocument());
  expect(screen.queryByText(/could not reach the converter/i)).toBeNull();
});

test("auto-selects the only uploaded layer as the match target", async () => {
  upload.mockResolvedValue([layer("station", 4, 4)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();

  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "Match with station" })).toBeChecked()
  );
});

test("does not auto-select when two layers are added together", async () => {
  upload.mockResolvedValue([layer("station", 4, 4), layer("parcels", 3, 3)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();

  await waitFor(() => expect(screen.getByRole("radio", { name: "Match with station" })).toBeInTheDocument());
  expect(screen.getByRole("radio", { name: "Match with station" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Match with parcels" })).not.toBeChecked();
});

test("clicking a match-target radio selects that layer", async () => {
  upload.mockResolvedValue([layer("station", 4, 4), layer("parcels", 3, 3)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();

  await waitFor(() => expect(screen.getByRole("radio", { name: "Match with parcels" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("radio", { name: "Match with parcels" }));
  expect(screen.getByRole("radio", { name: "Match with parcels" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Match with station" })).not.toBeChecked();
});

test("removing the selected layer among several clears the match target", async () => {
  upload
    .mockResolvedValueOnce([layer("station", 4, 4)])
    .mockResolvedValueOnce([layer("parcels", 3, 3)])
    .mockResolvedValueOnce([layer("roads", 2, 2)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "Match with station" })).toBeChecked()
  );
  addFile();
  await waitFor(() => expect(screen.getByRole("radio", { name: "Match with parcels" })).toBeInTheDocument());
  addFile();
  await waitFor(() => expect(screen.getByRole("radio", { name: "Match with roads" })).toBeInTheDocument());

  const stationRow = screen.getByRole("radio", { name: "Match with station" }).closest("li")!;
  fireEvent.click(stationRow.querySelector("button")!);

  expect(screen.queryByRole("radio", { name: "Match with station" })).toBeNull();
  expect(screen.getByRole("radio", { name: "Match with parcels" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Match with roads" })).not.toBeChecked();
});
