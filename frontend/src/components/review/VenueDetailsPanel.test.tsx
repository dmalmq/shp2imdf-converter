import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { VenueDetailsPanel } from "./VenueDetailsPanel";
import type { ReviewFeature } from "./types";

function feature(id: string, featureType: string, properties: Record<string, unknown>): ReviewFeature {
  return { type: "Feature", id, feature_type: featureType, geometry: null, properties };
}

// What the importer synthesizes when the dataset ships no Site/Building layer.
const placeholderVenue = feature("venue-1", "venue", { name: { en: "Venue" }, category: "unspecified" });
const placeholderBuilding = feature("building-1", "building", { name: { en: "Building" } });
const emptyAddress = feature("address-1", "address", {
  address: "",
  locality: "",
  province: null,
  country: "JP",
  postal_code: null
});

test("renders nothing when the session has no venue", () => {
  const { container } = render(
    <VenueDetailsPanel
      venue={null}
      building={null}
      address={null}
      language="en"
      onSave={vi.fn()}
      onRequestAutofill={vi.fn()}
    />
  );
  expect(container).toBeEmptyDOMElement();
});

test("opens flagged when the facility is still a placeholder", () => {
  render(
    <VenueDetailsPanel
      venue={placeholderVenue}
      building={placeholderBuilding}
      address={emptyAddress}
      language="en"
      onSave={vi.fn()}
      onRequestAutofill={vi.fn()}
    />
  );
  expect(screen.getByText("required")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Venue")).toBeInTheDocument();
});

test("saves the name as a language label and the category as a spec code", () => {
  const onSave = vi.fn();
  render(
    <VenueDetailsPanel
      venue={placeholderVenue}
      building={placeholderBuilding}
      address={emptyAddress}
      language="ja"
      onSave={onSave}
      onRequestAutofill={vi.fn()}
    />
  );

  fireEvent.change(screen.getByLabelText("Facility name"), { target: { value: "JR新宿駅" } });
  fireEvent.change(screen.getByLabelText("Facility category"), { target: { value: "A001" } });
  fireEvent.change(screen.getByLabelText("Building name"), { target: { value: "JR新宿駅" } });
  fireEvent.change(screen.getByLabelText("City"), { target: { value: "新宿区" } });
  fireEvent.click(screen.getByText("Save facility details"));

  expect(onSave).toHaveBeenCalledWith("venue-1", { name: { ja: "JR新宿駅" }, category: "A001" });
  expect(onSave).toHaveBeenCalledWith("building-1", { name: { ja: "JR新宿駅" } });
  expect(onSave).toHaveBeenCalledWith("address-1", { locality: "新宿区" });
});

test("autofill fills the address fields without saving", async () => {
  const onSave = vi.fn();
  const onRequestAutofill = vi.fn().mockResolvedValue({
    address: "3-38-1 Shinjuku",
    locality: "Shinjuku City",
    province: "JP-13",
    country: "JP",
    postal_code: "160-0022"
  });
  render(
    <VenueDetailsPanel
      venue={placeholderVenue}
      building={placeholderBuilding}
      address={emptyAddress}
      language="en"
      onSave={onSave}
      onRequestAutofill={onRequestAutofill}
    />
  );

  fireEvent.click(screen.getByText("Fill address from geometry"));

  await waitFor(() => expect(screen.getByDisplayValue("160-0022")).toBeInTheDocument());
  expect(screen.getByDisplayValue("3-38-1 Shinjuku")).toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
});
