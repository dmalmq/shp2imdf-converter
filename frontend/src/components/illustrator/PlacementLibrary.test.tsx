import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { createPlacement, listPlacements } from "../../api/client";
import type * as ApiClient from "../../api/client";
import { buildApiClientError } from "../../api/errors";
import type { PlacementState } from "../../hooks/useIllustratorPlacement";
import { PlacementLibrary } from "./PlacementLibrary";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  createPlacement: vi.fn(),
  listPlacements: vi.fn()
}));

const create = vi.mocked(createPlacement);

const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [
    {
      label: "1F",
      linked: true,
      pinned: false,
      artworkAnchor: [85, 80],
      mapAnchor: [139.7, 35.69],
      controlPoints: [],
      artworkBounds: [0, 0, 170, 160]
    }
  ],
  activeFloorLabel: "1F",
  scaleLocked: true
};

beforeEach(() => {
  vi.mocked(listPlacements).mockResolvedValue([]);
  create.mockReset();
});

async function saveAs(name: string) {
  render(<PlacementLibrary state={STATE} dispatch={vi.fn()} artworkBounds={[0, 0, 170, 160]} />);
  fireEvent.change(screen.getByPlaceholderText("Building name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

test("a duplicate name says the name is taken", async () => {
  create.mockRejectedValue(
    buildApiClientError(
      409,
      JSON.stringify({ detail: "A placement named 'x' already exists.", code: "PLACEMENT_NAME_TAKEN" })
    )
  );
  await saveAs("x");
  expect(await screen.findByText("That name is already taken.")).toBeInTheDocument();
});

test("any other save failure shows the real error", async () => {
  create.mockRejectedValue(
    buildApiClientError(422, JSON.stringify({ detail: "floors: field required", code: "VALIDATION_ERROR" }))
  );
  await saveAs("x");
  expect(await screen.findByText(/floors: field required/)).toBeInTheDocument();
  expect(screen.queryByText("That name is already taken.")).not.toBeInTheDocument();
});
