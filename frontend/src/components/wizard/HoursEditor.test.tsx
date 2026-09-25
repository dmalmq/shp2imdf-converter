import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { HoursEditor, parseOsmHours, toOsmHours } from "./HoursEditor";

test("Open and Closed set a day, and Copy Monday to all copies its hours", () => {
  const onChange = vi.fn();
  render(<HoursEditor value="Mo 05:00-23:30" onChange={onChange} />);

  const tuesday = screen.getByRole("group", { name: "Tuesday" });
  expect(within(tuesday).getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(tuesday).getByRole("button", { name: "Open" }));
  expect(onChange).toHaveBeenLastCalledWith("Mo 05:00-23:30; Tu 09:00-17:00");

  fireEvent.click(screen.getByRole("button", { name: "Copy Monday to all" }));
  expect(onChange).toHaveBeenLastCalledWith("Mo-Su 05:00-23:30; PH 05:00-23:30");
});

test("PH is emitted as a separate token, never merged into a weekday range", () => {
  const state = parseOsmHours("");
  for (const key of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su", "PH"]) {
    state[key] = { open: true, from: "09:00", to: "17:00" };
  }

  expect(toOsmHours(state)).toBe("Mo-Su 09:00-17:00; PH 09:00-17:00");
});

test("PH with different hours stays its own segment", () => {
  const state = parseOsmHours("");
  for (const key of ["Mo", "Tu", "We"]) {
    state[key] = { open: true, from: "09:00", to: "17:00" };
  }
  state["PH"] = { open: true, from: "10:00", to: "15:00" };

  expect(toOsmHours(state)).toBe("Mo-We 09:00-17:00; PH 10:00-15:00");
});

test("round-trips a Mo-Su plus PH string", () => {
  const value = "Mo-Su 09:00-17:00; PH 09:00-17:00";
  expect(toOsmHours(parseOsmHours(value))).toBe(value);
});
