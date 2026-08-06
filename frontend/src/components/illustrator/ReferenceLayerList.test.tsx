import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureCollection } from "geojson";

import { uploadReferenceLayers } from "../../api/client";
import type * as ApiClient from "../../api/client";
import { buildApiClientError } from "../../api/errors";
import type { ReferenceLayer } from "./PlacementMap";
import { ReferenceLayerList } from "./ReferenceLayerList";

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
  return <ReferenceLayerList layers={layers} onChange={setLayers} focusBounds={focusBounds} />;
}

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

  render(<ReferenceLayerList layers={[]} onChange={onChange} focusBounds={FOCUS} />);
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

  render(<ReferenceLayerList layers={[]} onChange={() => {}} />);
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

  render(<ReferenceLayerList layers={[]} onChange={() => {}} />);
  addFile();

  await waitFor(() => expect(screen.getByText("Not a readable shapefile.")).toBeInTheDocument());
  expect(screen.queryByText(/could not reach the converter/i)).toBeNull();
});
