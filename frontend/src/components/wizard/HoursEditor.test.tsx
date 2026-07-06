import { parseOsmHours, toOsmHours } from "./HoursEditor";

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
