import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { geocodeSearch, type GeocodeResultItem } from "../../api/client";
import type { PlacementAction } from "../../hooks/useIllustratorPlacement";
import { LocateControl } from "./LocateControl";

vi.mock("../../api/client", () => ({
  geocodeSearch: vi.fn()
}));

const EMPTY_ADDRESS = {
  address: null,
  unit: null,
  locality: null,
  province: null,
  country: null,
  postal_code: null,
  postal_code_ext: null,
  postal_code_vanity: null
};

const oimachiStaWire: GeocodeResultItem = {
  display_name: "大井町駅, 品川区, 東京都",
  latitude: 35.6063,
  longitude: 139.7286,
  source: "nominatim",
  address: EMPTY_ADDRESS
};

const oimachiTownWire: GeocodeResultItem = {
  display_name: "大井町, 足柄上郡, 神奈川県",
  latitude: 35.322,
  longitude: 139.117,
  source: "nominatim",
  address: EMPTY_ADDRESS
};

beforeEach(() => {
  vi.mocked(geocodeSearch).mockReset();
});

function renderLocate(siteName: string) {
  const seen: PlacementAction[] = [];
  const recenter: [number, number][] = [];
  const view = render(
    <LocateControl
      siteName={siteName}
      dispatch={(action) => seen.push(action)}
      onLocate={(lngLat) => recenter.push(lngLat)}
    />
  );
  return { seen, recenter, ...view };
}

test("empty siteName does not search and the row is Find the building", () => {
  renderLocate("");
  expect(geocodeSearch).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /find the building/i })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  expect(screen.queryByRole("listitem")).toBeNull();
});

test("filename auto-locate places the first hit without opening the list", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([oimachiStaWire, oimachiTownWire]);
  const { seen, recenter } = renderLocate("大井町");
  await screen.findByText(/first match/i);
  const row = screen.getByRole("button", { name: /大井町/ });
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/first match/i)).toBeInTheDocument();
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.queryByText(oimachiStaWire.display_name)).toBeNull();
  expect(seen).toEqual([
    { type: "positionBuilding", mapAnchor: [139.7286, 35.6063], baseline: true }
  ]);
  expect(recenter).toEqual([[139.7286, 35.6063]]);
});

test("opening the row lists filename hits; picking one collapses and repositions", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([oimachiStaWire, oimachiTownWire]);
  const { seen } = renderLocate("大井町");
  await screen.findByText(/first match/i);
  const row = screen.getByRole("button", { name: /大井町/ });
  fireEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("region", { name: /find the building/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: oimachiStaWire.display_name })).toHaveAttribute(
    "title",
    oimachiStaWire.display_name
  );
  fireEvent.click(screen.getByRole("button", { name: oimachiTownWire.display_name }));
  expect(seen.at(-1)).toEqual({
    type: "positionBuilding",
    mapAnchor: [139.117, 35.322],
    baseline: false
  });
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.queryByRole("region", { name: /find the building/i })).toBeNull();
});

test("picking the already-located place collapses without a second positionBuilding", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([oimachiStaWire, oimachiTownWire]);
  const { seen } = renderLocate("大井町");
  await screen.findByText(/first match/i);
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  fireEvent.click(screen.getByRole("button", { name: oimachiStaWire.display_name }));
  expect(seen).toEqual([
    { type: "positionBuilding", mapAnchor: [139.7286, 35.6063], baseline: true }
  ]);
  expect(screen.queryByRole("listitem")).toBeNull();
});

test("Search is disabled while the query is empty or a search is pending; Enter submits", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([]);
  renderLocate("");
  fireEvent.click(screen.getByRole("button", { name: /find the building/i }));
  const searchButton = screen.getByRole("button", { name: /^search$/i });
  expect(searchButton).toBeDisabled();
  const field = screen.getByPlaceholderText(/新宿駅/);
  fireEvent.change(field, { target: { value: "新宿" } });
  expect(searchButton).toBeEnabled();

  let finish!: (value: GeocodeResultItem[]) => void;
  vi.mocked(geocodeSearch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("button", { name: /searching/i })).toBeDisabled());
  finish([]);
  await screen.findByText(/no places found/i);
});

test("Escape closes the open box and does not reach window listeners", async () => {
  vi.mocked(geocodeSearch).mockRejectedValue(new Error("down"));
  const onWindowEscape = vi.fn();
  window.addEventListener("keydown", onWindowEscape);
  renderLocate("");
  const row = screen.getByRole("button", { name: /find the building/i });
  fireEvent.click(row);
  fireEvent.change(screen.getByPlaceholderText(/新宿駅/), { target: { value: "新宿" } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
  expect(await screen.findByText(/address search is unavailable/i)).toBeInTheDocument();
  fireEvent.keyDown(row, { key: "Escape" });
  expect(screen.queryByRole("region", { name: /find the building/i })).toBeNull();
  expect(onWindowEscape).not.toHaveBeenCalled();
  window.removeEventListener("keydown", onWindowEscape);
});

test("opening the row focuses the query field so Escape from the input closes", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([]);
  renderLocate("");
  fireEvent.click(screen.getByRole("button", { name: /find the building/i }));
  const field = screen.getByPlaceholderText(/新宿駅/);
  expect(field).toHaveFocus();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("region", { name: /find the building/i })).toBeNull();
});

test("reopening after a pick lists cached hits without a second geocode", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([oimachiStaWire, oimachiTownWire]);
  renderLocate("大井町");
  await screen.findByText(/first match/i);
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  fireEvent.click(screen.getByRole("button", { name: oimachiTownWire.display_name }));
  expect(geocodeSearch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  expect(screen.getByRole("button", { name: oimachiStaWire.display_name })).toBeInTheDocument();
  expect(geocodeSearch).toHaveBeenCalledTimes(1);
});

const shinjukuStaWire: GeocodeResultItem = {
  display_name: "新宿駅, 新宿区, 東京都",
  latitude: 35.6896,
  longitude: 139.7003,
  source: "nominatim",
  address: EMPTY_ADDRESS
};

test("reopening after a later search keeps that query in the field with those hits", async () => {
  vi.mocked(geocodeSearch).mockResolvedValueOnce([oimachiStaWire, oimachiTownWire]);
  renderLocate("大井町");
  await screen.findByText(/first match/i);
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  vi.mocked(geocodeSearch).mockResolvedValueOnce([shinjukuStaWire]);
  const field = screen.getByPlaceholderText(/新宿駅/);
  fireEvent.change(field, { target: { value: "新宿" } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
  fireEvent.click(await screen.findByRole("button", { name: shinjukuStaWire.display_name }));
  expect(screen.queryByRole("listitem")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  expect(screen.getByPlaceholderText(/新宿駅/)).toHaveValue("新宿");
  expect(screen.getByRole("button", { name: shinjukuStaWire.display_name })).toBeInTheDocument();
  expect(screen.queryByText(oimachiStaWire.display_name)).toBeNull();
});
