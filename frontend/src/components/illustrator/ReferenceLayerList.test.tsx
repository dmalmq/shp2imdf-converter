import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureCollection } from "geojson";

import { uploadReferenceLayers, fetchPreloadedReferenceLayers, getPreloadedReferenceOverlay } from "../../api/client";
import type * as ApiClient from "../../api/client";
import { buildApiClientError } from "../../api/errors";
import type { ReferenceLayer } from "./PlacementMap";
import {
  nextMatchTarget,
  preferSurveyLayer,
  ReferenceLayerList,
  surveyLayerName
} from "./ReferenceLayerList";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  uploadReferenceLayers: vi.fn(),
  fetchPreloadedReferenceLayers: vi.fn(),
  getPreloadedReferenceOverlay: vi.fn()
}));

const upload = vi.mocked(uploadReferenceLayers);
const fetchPreloaded = vi.mocked(fetchPreloadedReferenceLayers);
const getPreloaded = vi.mocked(getPreloadedReferenceOverlay);

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
  fetchPreloaded.mockReset();
  getPreloaded.mockReset();
  getPreloaded.mockResolvedValue({ available: false, label: "駅データ" });
  fetchPreloaded.mockResolvedValue([]);
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
    setMatchTargetName((current) => preferSurveyLayer(next, current));
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
  expect(preferSurveyLayer([{ name: "station" }], "")).toBe("station");
  expect(
    preferSurveyLayer([{ name: "station" }, { name: "parcels" }], "station")
  ).toBe("station");
  expect(preferSurveyLayer([{ name: "parcels" }, { name: "roads" }], "station")).toBe("");
  expect(preferSurveyLayer([{ name: "parcels" }], "station")).toBe("parcels");
  expect(preferSurveyLayer([], "station")).toBe("");
});

const EKI_DATA = [
  { name: "Station_pg" },
  { name: "Station_pl" },
  { name: "Station_pt" },
  { name: "StationUse" }
];

test("prefers Station_pg among the 駅データ layers and never defaults to Station_pl", () => {
  expect(preferSurveyLayer(EKI_DATA, "")).toBe("Station_pg");
  expect(preferSurveyLayer(EKI_DATA, "StationUse")).toBe("StationUse");
  expect(preferSurveyLayer([{ name: "Station_pl" }, { name: "Station_pg (2)" }], "")).toBe(
    "Station_pg (2)"
  );
  expect(preferSurveyLayer([{ name: "Station_pl" }], "")).toBe("");
  expect(preferSurveyLayer([{ name: "Station_pl" }, { name: "parcels" }], "")).toBe("parcels");
  expect(surveyLayerName(EKI_DATA)).toBe("Station_pg");
  expect(surveyLayerName([{ name: "Station_pl" }, { name: "parcels" }])).toBe("");
});

test("a fresh match target lands on Station_pg even when other floors exist", () => {
  expect(
    nextMatchTarget(EKI_DATA, ["1F", "2F"], "1F", { referenceName: "", referenceFloorLabel: "" })
  ).toEqual({ referenceName: "Station_pg", referenceFloorLabel: "" });
  expect(
    nextMatchTarget([{ name: "Station_pl" }], ["1F", "2F"], "1F", {
      referenceName: "",
      referenceFloorLabel: ""
    })
  ).toEqual({ referenceName: "", referenceFloorLabel: "2F" });
});

test("an unstacked floor defaults to the previous stacked floor, not Station_pg", () => {
  const empty = { referenceName: "", referenceFloorLabel: "" };
  expect(
    nextMatchTarget(EKI_DATA, ["1F", "2F", "3F", "4F"], "4F", empty, ["4F"])
  ).toEqual({ referenceName: "", referenceFloorLabel: "3F" });
  expect(
    nextMatchTarget(
      EKI_DATA,
      ["1F", "2F", "3F", "4F"],
      "4F",
      { referenceName: "Station_pg", referenceFloorLabel: "" },
      ["4F"]
    )
  ).toEqual({ referenceName: "", referenceFloorLabel: "3F" });
  expect(
    nextMatchTarget(EKI_DATA, ["1F", "2F", "3F", "4F"], "1F", empty, ["4F"])
  ).toEqual({ referenceName: "Station_pg", referenceFloorLabel: "" });
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

test("Add shapefile is disabled until a station pin supplies focus bounds", () => {
  render(<ListHarness />);
  expect(screen.getByRole("button", { name: /add shapefile/i })).toBeDisabled();
  expect(screen.getByText(/identify the station/i)).toBeInTheDocument();
  addFile();
  expect(upload).not.toHaveBeenCalled();
});

test("changing the pin re-reads the archived zip around the new bounds", async () => {
  upload.mockResolvedValue([layer("station", 12139, 331)]);
  function PinHarness() {
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(FOCUS);
    const [layers, setLayers] = useState<ReferenceLayer[]>([]);
    return (
      <>
        <button type="button" onClick={() => setBounds([140.11, 35.61, 140.11, 35.61])}>
          move pin
        </button>
        <ReferenceLayerList
          layers={layers}
          onChange={setLayers}
          matchTargetName=""
          onMatchTargetChange={() => {}}
          focusBounds={bounds}
        />
      </>
    );
  }
  render(<PinHarness />);
  addFile();
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(upload.mock.calls[0][1]).toEqual(FOCUS);
  fireEvent.click(screen.getByRole("button", { name: /move pin/i }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(upload.mock.calls[1][1]).toEqual([140.11, 35.61, 140.11, 35.61]);
});

test("a pin move re-reads every shapefile that was added, not only the last", async () => {
  upload.mockResolvedValue([layer("station", 4, 4)]);
  function PinHarness() {
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(FOCUS);
    const [layers, setLayers] = useState<ReferenceLayer[]>([]);
    return (
      <>
        <button type="button" onClick={() => setBounds([140.11, 35.61, 140.11, 35.61])}>
          move pin
        </button>
        <ReferenceLayerList
          layers={layers}
          onChange={setLayers}
          matchTargetName=""
          onMatchTargetChange={() => {}}
          focusBounds={bounds}
        />
      </>
    );
  }
  render(<PinHarness />);
  addFile();
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  addFile();
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(upload.mock.calls[1][0]).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /move pin/i }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
  expect(upload.mock.calls[2][0]).toHaveLength(2);
});

test("a failed add is not archived, so a pin move does not retry it", async () => {
  upload.mockRejectedValue(buildApiClientError(422, JSON.stringify({ detail: "Not a readable shapefile." })));
  function PinHarness() {
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(FOCUS);
    const [layers, setLayers] = useState<ReferenceLayer[]>([]);
    return (
      <>
        <button type="button" onClick={() => setBounds([140.11, 35.61, 140.11, 35.61])}>
          move pin
        </button>
        <ReferenceLayerList
          layers={layers}
          onChange={setLayers}
          matchTargetName=""
          onMatchTargetChange={() => {}}
          focusBounds={bounds}
        />
      </>
    );
  }
  render(<PinHarness />);
  addFile();
  await waitFor(() => expect(screen.getByText("Not a readable shapefile.")).toBeInTheDocument());
  upload.mockResolvedValue([layer("station", 4, 4)]);
  fireEvent.click(screen.getByRole("button", { name: /move pin/i }));
  expect(upload).toHaveBeenCalledTimes(1);
});

test("removing a layer keeps it off after a pin move", async () => {
  upload.mockResolvedValue([layer("station", 4, 4)]);
  function PinHarness() {
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(FOCUS);
    const [layers, setLayers] = useState<ReferenceLayer[]>([]);
    return (
      <>
        <button type="button" onClick={() => setBounds([140.11, 35.61, 140.11, 35.61])}>
          move pin
        </button>
        <ReferenceLayerList
          layers={layers}
          onChange={setLayers}
          matchTargetName=""
          onMatchTargetChange={() => {}}
          focusBounds={bounds}
        />
      </>
    );
  }
  render(<PinHarness />);
  addFile();
  await waitFor(() => expect(screen.getByText("station")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /remove/i }));
  expect(screen.queryByText("station")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /move pin/i }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("station")).toBeNull();
});

test("shows the kept count over the source total when a spatial trim happened", async () => {
  upload.mockResolvedValue([layer("station", 12139, 842)]);

  render(<ListHarness focusBounds={FOCUS} />);
  addFile();

  await waitFor(() => expect(screen.getByText("842 / 12139")).toBeInTheDocument());
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
    expect(screen.getByText(/nothing was found near the station/i)).toBeInTheDocument()
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
      focusBounds={FOCUS}
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
      focusBounds={FOCUS}
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

test("Load 駅データ is hidden until the server has a preloaded extract", async () => {
  render(<ListHarness focusBounds={FOCUS} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /add shapefile/i })).toBeInTheDocument());
  expect(screen.queryByTestId("load-eki-data")).toBeNull();
});

test("Load 駅データ is disabled until a station pin supplies focus bounds", async () => {
  getPreloaded.mockResolvedValue({ available: true, label: "駅データ" });
  render(<ListHarness />);
  await waitFor(() => expect(screen.getByTestId("load-eki-data")).toBeDisabled());
  fireEvent.click(screen.getByTestId("load-eki-data"));
  expect(fetchPreloaded).not.toHaveBeenCalled();
});

test("Load 駅データ queries the server copy and does not POST files", async () => {
  getPreloaded.mockResolvedValue({ available: true, label: "駅データ" });
  fetchPreloaded.mockResolvedValue([layer("Station_pg", 12139, 493), layer("Station_pt", 5059, 199)]);
  render(<ListHarness focusBounds={FOCUS} />);
  await waitFor(() => expect(screen.getByTestId("load-eki-data")).toBeEnabled());
  fireEvent.click(screen.getByTestId("load-eki-data"));
  await waitFor(() => expect(screen.getByText("Station_pg")).toBeInTheDocument());
  expect(fetchPreloaded).toHaveBeenCalledTimes(1);
  expect(fetchPreloaded.mock.calls[0][0]).toEqual(FOCUS);
  expect(fetchPreloaded.mock.calls[0][1]).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(screen.queryByText("Station_pl")).toBeNull();
});

test("changing the pin re-queries preload without uploading files", async () => {
  getPreloaded.mockResolvedValue({ available: true, label: "駅データ" });
  fetchPreloaded.mockResolvedValue([layer("Station_pg", 12139, 493)]);
  function PinHarness() {
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(FOCUS);
    const [layers, setLayers] = useState<ReferenceLayer[]>([]);
    return (
      <>
        <button type="button" onClick={() => setBounds([140.11, 35.61, 140.11, 35.61])}>
          move pin
        </button>
        <ReferenceLayerList
          layers={layers}
          onChange={setLayers}
          matchTargetName=""
          onMatchTargetChange={() => {}}
          focusBounds={bounds}
        />
      </>
    );
  }
  render(<PinHarness />);
  await waitFor(() => expect(screen.getByTestId("load-eki-data")).toBeEnabled());
  fireEvent.click(screen.getByTestId("load-eki-data"));
  await waitFor(() => expect(fetchPreloaded).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: /move pin/i }));
  await waitFor(() => expect(fetchPreloaded).toHaveBeenCalledTimes(2));
  expect(fetchPreloaded.mock.calls[1][0]).toEqual([140.11, 35.61, 140.11, 35.61]);
  expect(upload).not.toHaveBeenCalled();
});

test("Show survey lines opts into Station_pl on the server copy", async () => {
  getPreloaded.mockResolvedValue({ available: true, label: "駅データ" });
  fetchPreloaded
    .mockResolvedValueOnce([layer("Station_pg", 4, 4)])
    .mockResolvedValueOnce([layer("Station_pg", 4, 4), layer("Station_pl", 8, 8)]);
  render(<ListHarness focusBounds={FOCUS} />);
  await waitFor(() => expect(screen.getByTestId("load-eki-data")).toBeEnabled());
  fireEvent.click(screen.getByTestId("load-eki-data"));
  await waitFor(() => expect(screen.getByText("Station_pg")).toBeInTheDocument());
  expect(screen.queryByText("Station_pl")).toBeNull();
  fireEvent.click(screen.getByTestId("include-survey-lines"));
  await waitFor(() => expect(screen.getByText("Station_pl")).toBeInTheDocument());
  expect(fetchPreloaded.mock.calls[1][1]).toBe(true);
  expect(upload).not.toHaveBeenCalled();
});

test("Add shapefile still uploads a picked file after preload", async () => {
  getPreloaded.mockResolvedValue({ available: true, label: "駅データ" });
  fetchPreloaded.mockResolvedValue([layer("Station_pg", 4, 4)]);
  upload.mockResolvedValue([layer("platforms", 2, 2)]);
  render(<ListHarness focusBounds={FOCUS} />);
  await waitFor(() => expect(screen.getByTestId("load-eki-data")).toBeEnabled());
  fireEvent.click(screen.getByTestId("load-eki-data"));
  await waitFor(() => expect(screen.getByText("Station_pg")).toBeInTheDocument());
  addFile();
  await waitFor(() => expect(screen.getByText("platforms")).toBeInTheDocument());
  expect(upload).toHaveBeenCalledTimes(1);
  expect(upload.mock.calls[0][0][0]).toEqual(expect.objectContaining({ name: "station.shp" }));
});

test("pin move re-queries preload and re-uploads only the picked files", async () => {
  getPreloaded.mockResolvedValue({ available: true, label: "駅データ" });
  fetchPreloaded.mockResolvedValue([layer("Station_pg", 4, 4)]);
  upload.mockResolvedValue([layer("platforms", 2, 2)]);
  function PinHarness() {
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(FOCUS);
    const [layers, setLayers] = useState<ReferenceLayer[]>([]);
    return (
      <>
        <button type="button" onClick={() => setBounds([140.11, 35.61, 140.11, 35.61])}>
          move pin
        </button>
        <ReferenceLayerList
          layers={layers}
          onChange={setLayers}
          matchTargetName=""
          onMatchTargetChange={() => {}}
          focusBounds={bounds}
        />
      </>
    );
  }
  render(<PinHarness />);
  await waitFor(() => expect(screen.getByTestId("load-eki-data")).toBeEnabled());
  fireEvent.click(screen.getByTestId("load-eki-data"));
  await waitFor(() => expect(screen.getByText("Station_pg")).toBeInTheDocument());
  addFile();
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: /move pin/i }));
  await waitFor(() => expect(fetchPreloaded).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(upload.mock.calls[1][0]).toHaveLength(1);
  expect(upload.mock.calls[1][0][0]).toEqual(expect.objectContaining({ name: "station.shp" }));
});
