import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { fetchHandover, saveHandoverNote, type Handover } from "../../api/client";
import { useAppStore } from "../../store/useAppStore";
import { WelcomeBack } from "./WelcomeBack";

vi.mock("../../api/client", () => ({ fetchHandover: vi.fn(), saveHandoverNote: vi.fn() }));

const RESUMED: Handover = {
  visit_started_at: "2026-09-25T08:00:00Z",
  last_visit: {
    started_at: "2026-08-18T01:00:00Z",
    ended_at: "2026-08-18T02:40:00Z",
    events: [
      { at: "2026-08-18T01:10:00Z", kind: "setup_changed", n: 1, params: { section: "levels" } },
      { at: "2026-08-18T02:40:00Z", kind: "features_edited", n: 12, params: {} }
    ],
    dropped: 3
  },
  note: { text: "屋外 outline still provisional.", at: "2026-08-18T02:41:00Z" }
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useAppStore.setState({ uiLanguage: "en" });
});

test("shows the last visit, newest change first, with the note", async () => {
  vi.mocked(fetchHandover).mockResolvedValue(RESUMED);
  render(<WelcomeBack sessionId="s-1" station="東京駅" />);

  expect(await screen.findByRole("dialog", { name: "Last time on 東京駅" })).toBeInTheDocument();
  expect(screen.getByText(/^Last session · 18 Aug( 2026)? · 1 h 40 min$/)).toBeInTheDocument();
  const lines = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(lines).toEqual(["Edited 12 features", "Changed the level mapping", "and 3 earlier changes"]);
  expect(screen.getByRole("textbox")).toHaveValue("屋外 outline still provisional.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus());
});

test("dismissing keeps it away for the rest of the visit", async () => {
  vi.mocked(fetchHandover).mockResolvedValue(RESUMED);
  const { unmount } = render(<WelcomeBack sessionId="s-1" station="東京駅" />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  unmount();

  render(<WelcomeBack sessionId="s-1" station="東京駅" />);
  await waitFor(() => expect(fetchHandover).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).toBeNull();

  vi.mocked(fetchHandover).mockResolvedValue({ ...RESUMED, visit_started_at: "2026-09-26T08:00:00Z" });
  render(<WelcomeBack sessionId="s-1" station="東京駅" />);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

test("a project's first visit has nothing to welcome back to", async () => {
  vi.mocked(fetchHandover).mockResolvedValue({ ...RESUMED, last_visit: null });
  render(<WelcomeBack sessionId="s-1" station="東京駅" />);
  await waitFor(() => expect(fetchHandover).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(saveHandoverNote).not.toHaveBeenCalled();
});

test("reads in Japanese", async () => {
  useAppStore.setState({ uiLanguage: "ja" });
  vi.mocked(fetchHandover).mockResolvedValue(RESUMED);
  render(<WelcomeBack sessionId="s-1" station="東京駅" />);
  expect(await screen.findByRole("dialog", { name: "前回の 東京駅" })).toBeInTheDocument();
  expect(screen.getByText("12 件のフィーチャーを編集")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "続ける" })).toBeInTheDocument();
});
