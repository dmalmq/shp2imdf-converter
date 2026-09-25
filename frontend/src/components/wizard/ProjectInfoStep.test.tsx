import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { ProjectWizardState } from "../../api/client";
import { ProjectInfoStep } from "./ProjectInfoStep";

vi.mock("../../api/client", () => ({
  getIsoSubdivisions: vi.fn(() => Promise.resolve({ country: "JP", subdivisions: [] }))
}));

const PROJECT: ProjectWizardState = {
  project_name: null,
  venue_name: "東京駅",
  venue_category: "transitstation",
  language: "ja",
  venue_restriction: null,
  venue_hours: null,
  venue_phone: null,
  venue_website: null,
  address: {
    address: null,
    unit: null,
    locality: "千代田区",
    province: null,
    country: "jp ",
    postal_code: null,
    postal_code_ext: null,
    postal_code_vanity: null
  }
};

function renderStep(onChange = vi.fn()) {
  render(
    <ProjectInfoStep
      project={PROJECT}
      onChange={onChange}
      onSearchAddress={async () => []}
      onAutofillFromGeometry={async () => null}
    />
  );
  return onChange;
}

test("Other… takes any language tag in its canonical form, and says so when it is not one", async () => {
  const onChange = renderStep();
  fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
  fireEvent.click(await screen.findByRole("option", { name: "Other…" }));

  const tag = screen.getByRole("textbox", { name: "Language tag" });
  fireEvent.change(tag, { target: { value: "not a tag" } });
  fireEvent.click(screen.getByRole("button", { name: "Use" }));
  expect(screen.getByRole("alert")).toHaveTextContent("That is not a language tag");
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.change(tag, { target: { value: "pt-br" } });
  fireEvent.click(screen.getByRole("button", { name: "Use" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: "pt-BR" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a stored country with stray case or spaces shows as its country, once, without being rewritten", async () => {
  const onChange = renderStep();
  const country = screen.getByRole("combobox", { name: "Country" });
  expect(country).toHaveTextContent("Japan");
  fireEvent.click(country);
  const listbox = await screen.findByRole("listbox");
  expect(within(listbox).getAllByRole("option", { name: "Japan" })).toHaveLength(1);
  expect(onChange).not.toHaveBeenCalled();
});
