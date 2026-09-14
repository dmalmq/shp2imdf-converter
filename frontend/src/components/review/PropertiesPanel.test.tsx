import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import type { FeatureTypeOption } from "../../api/client";
import { PropertiesPanel } from "./PropertiesPanel";
import type { ReviewFeature } from "./types";

const CATALOG: FeatureTypeOption[] = [
  {
    feature_type: "address",
    geometry: "null",
    has_category: false,
    categories: null,
    default_category: null
  },
  {
    feature_type: "unit",
    geometry: "polygon",
    has_category: true,
    categories: ["auditorium", "road", "unspecified", "walkway"],
    default_category: "unspecified"
  },
  {
    feature_type: "geofence",
    geometry: "polygon",
    has_category: true,
    categories: [
      "concourse",
      "geofence",
      "paidarea",
      "platform",
      "postsecurity",
      "presecurity",
      "terminal",
      "underconstruction"
    ],
    default_category: "geofence"
  },
  {
    feature_type: "detail",
    geometry: "line",
    has_category: false,
    categories: null,
    default_category: null
  }
];

const polygonUnit: ReviewFeature = {
  type: "Feature",
  id: "unit-road-1",
  feature_type: "unit",
  geometry: { type: "Polygon", coordinates: [] },
  properties: { category: "road", name: { en: "Service road" } }
};

function renderPanel(
  onSave: (featureId: string, properties: Record<string, unknown>, featureType?: string) => void = vi.fn()
) {
  return render(
    <PropertiesPanel
      feature={polygonUnit}
      language="en"
      levelOptions={[]}
      addressOptions={[]}
      featureTypes={CATALOG}
      onSave={onSave}
      onDelete={vi.fn()}
    />
  );
}

function optionValues(label: string): string[] {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  return [...select.options].map((option) => option.value);
}

test("a polygon unit offers geofence and not line-only or null-geometry types", () => {
  renderPanel();
  const values = optionValues("Feature type");
  expect(values).toContain("unit");
  expect(values).toContain("geofence");
  expect(values).not.toContain("detail");
  expect(values).not.toContain("address");
});

test("saving after selecting geofence passes the new type", () => {
  const onSave = vi.fn();
  renderPanel(onSave);
  fireEvent.change(screen.getByLabelText("Feature type"), { target: { value: "geofence" } });
  fireEvent.click(screen.getByText("Save Changes"));
  expect(onSave).toHaveBeenCalledWith("unit-road-1", expect.any(Object), "geofence");
});

test("saving without changing type omits the third argument", () => {
  const onSave = vi.fn();
  renderPanel(onSave);
  fireEvent.click(screen.getByText("Save Changes"));
  expect(onSave).toHaveBeenCalledWith("unit-road-1", expect.any(Object), undefined);
});

test("switching type to geofence replaces an invalid category with the target default", () => {
  renderPanel();
  const categorySelect = screen.getByLabelText("category") as HTMLSelectElement;
  expect(categorySelect.tagName).toBe("SELECT");
  expect(optionValues("category")).toEqual(["", "auditorium", "road", "unspecified", "walkway"]);
  expect(categorySelect.value).toBe("road");

  fireEvent.change(screen.getByLabelText("Feature type"), { target: { value: "geofence" } });

  expect(categorySelect.value).toBe("geofence");
  expect(optionValues("category")).toEqual([
    "",
    "concourse",
    "geofence",
    "paidarea",
    "platform",
    "postsecurity",
    "presecurity",
    "terminal",
    "underconstruction"
  ]);
});
