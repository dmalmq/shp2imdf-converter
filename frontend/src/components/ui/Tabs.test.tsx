import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { Tabs, tabPanelProps, type TabDefinition } from "./Tabs";


const TABS: TabDefinition[] = [
  { id: "fit", label: "Scale & fit" },
  { id: "reference", label: "Reference" },
  { id: "export", label: "Export" }
];

function Harness() {
  const [active, setActive] = useState("fit");
  return (
    <div>
      <Tabs tabs={TABS} active={active} onChange={setActive} idPrefix="p" />
      {TABS.map((tab) => (
        <div key={tab.id} {...tabPanelProps("p", tab.id, tab.id === active)}>
          panel {tab.id}
        </div>
      ))}
    </div>
  );
}


test("renders one tab per definition with the active one selected", () => {
  render(<Harness />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(3);
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  expect(tabs[1]).toHaveAttribute("aria-selected", "false");
});

test("each tab controls the panel labelled by it", () => {
  render(<Harness />);
  const tab = screen.getAllByRole("tab")[1];
  const panelId = tab.getAttribute("aria-controls")!;
  const panel = document.getElementById(panelId)!;
  expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  expect(panel).toHaveAttribute("role", "tabpanel");
});

test("every panel stays in the DOM; only the active one is exposed", () => {
  render(<Harness />);
  // All three are rendered — remounting would discard panel-local state.
  expect(document.querySelectorAll("[role=tabpanel]")).toHaveLength(3);
  // Only one is visible to the accessibility tree.
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(screen.getByRole("tabpanel")).toHaveTextContent("panel fit");
});

test("clicking a tab activates it and swaps the exposed panel", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("tab", { name: "Export" }));
  expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("panel export");
});

test("only the active tab is keyboard-reachable (roving tabindex)", () => {
  render(<Harness />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs[0]).toHaveAttribute("tabindex", "0");
  expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  expect(tabs[2]).toHaveAttribute("tabindex", "-1");
});

test("arrow keys move between tabs and wrap around", () => {
  render(<Harness />);
  const strip = screen.getByRole("tablist");
  fireEvent.keyDown(strip, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Reference" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(strip, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Scale & fit" })).toHaveAttribute("aria-selected", "true");
  // wraps backwards from the first to the last
  fireEvent.keyDown(strip, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
});

test("Home and End jump to the first and last tab", () => {
  render(<Harness />);
  const strip = screen.getByRole("tablist");
  fireEvent.keyDown(strip, { key: "End" });
  expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(strip, { key: "Home" });
  expect(screen.getByRole("tab", { name: "Scale & fit" })).toHaveAttribute("aria-selected", "true");
});

test("an unrelated key does not change the active tab", () => {
  render(<Harness />);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "a" });
  expect(screen.getByRole("tab", { name: "Scale & fit" })).toHaveAttribute("aria-selected", "true");
});
