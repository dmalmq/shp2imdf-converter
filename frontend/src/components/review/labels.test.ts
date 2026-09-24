import { labelLanguage, labelText, setLabelText } from "./labels";

const gate = { ja: "改札", en: "Ticket gate" };

test("display picks the active language", () => {
  expect(labelText(gate, "ja")).toBe("改札");
  expect(labelText(gate, "en")).toBe("Ticket gate");
});

test("display falls back to the first language when the active one is missing", () => {
  expect(labelText({ ja: "改札" }, "en")).toBe("改札");
  expect(labelLanguage({ ja: "改札" }, "en")).toBe("ja");
});

test("an empty or missing label edits the active language", () => {
  expect(labelLanguage(null, "en")).toBe("en");
  expect(labelLanguage({}, "ja")).toBe("ja");
  expect(labelLanguage(gate, "en")).toBe("en");
});

test("a plain string still displays", () => {
  expect(labelText("改札", "en")).toBe("改札");
});

test("merge keeps the other languages", () => {
  expect(setLabelText(gate, "en", "Gate")).toEqual({ ja: "改札", en: "Gate" });
  expect(setLabelText({ ja: "改札" }, "en", "Gate")).toEqual({ ja: "改札", en: "Gate" });
});

test("clearing removes only that language", () => {
  expect(setLabelText(gate, "en", "")).toEqual({ ja: "改札" });
  expect(setLabelText({ ja: "改札" }, "ja", "")).toBeNull();
});

test("merge does not mutate the original label", () => {
  const original = { ja: "改札" };
  setLabelText(original, "en", "Gate");
  expect(original).toEqual({ ja: "改札" });
});
