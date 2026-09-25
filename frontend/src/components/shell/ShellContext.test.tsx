import React, { useRef, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { useAppStore } from "../../store/useAppStore";
import { AppShell } from "./AppShell";
import { createSlot, usePageShell, usePrimaryAction, type PrimaryAction } from "./ShellContext";

describe("createSlot", () => {
  test("the latest registration wins and removing it reveals the previous one", () => {
    const slot = createSlot<string>();
    const a = {};
    const b = {};
    expect(slot.get()).toBeNull();
    slot.set(a, "upload");
    slot.set(b, "wizard");
    expect(slot.get()).toBe("wizard");
    slot.set(a, "upload again");
    expect(slot.get()).toBe("wizard");
    slot.remove(b);
    expect(slot.get()).toBe("upload again");
    slot.remove(a);
    expect(slot.get()).toBeNull();
  });

  test("notifies subscribers of changes only", () => {
    const slot = createSlot<number>();
    const listener = vi.fn();
    const unsubscribe = slot.subscribe(listener);
    const key = {};
    slot.set(key, 1);
    slot.remove({});
    slot.remove(key);
    unsubscribe();
    slot.set(key, 2);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

type Observed = { callback: IntersectionObserverCallback; target: Element | null };
let observers: Observed[] = [];

class FakeIntersectionObserver {
  private entry: Observed;
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, target: null };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.target = target;
  }
  disconnect() {
    observers = observers.filter((observer) => observer !== this.entry);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

function setVisible(visible: boolean) {
  act(() => {
    for (const { callback, target } of observers) {
      callback(
        [{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0, target } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }
  });
}

function Page({ action, withAnchor }: { action: Omit<PrimaryAction, "anchor">; withAnchor: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  usePrimaryAction({ ...action, anchor: withAnchor ? anchor : undefined });
  return withAnchor ? (
    <button ref={anchor} type="button" onClick={action.run}>
      {action.label}
    </button>
  ) : null;
}

function renderShell(children: React.ReactNode, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>{children}</AppShell>
    </MemoryRouter>
  );
}

const topBar = () => screen.getByRole("banner");

describe("primary action", () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    useAppStore.setState({ uiLanguage: "en", sessionId: null, currentScreen: "upload" });
  });
  afterEach(() => vi.unstubAllGlobals());

  test("a page without its own button gets the action in the top bar", () => {
    const run = vi.fn();
    renderShell(<Page action={{ label: "Import & Continue", run }} withAnchor={false} />);
    fireEvent.click(within(topBar()).getByRole("button", { name: "Import & Continue" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("the top bar shows it only while the page's own button is out of view", () => {
    renderShell(<Page action={{ label: "Import & Continue", run: () => {} }} withAnchor />);
    setVisible(true);
    expect(screen.getAllByRole("button", { name: "Import & Continue" })).toHaveLength(1);
    setVisible(false);
    expect(within(topBar()).getByRole("button", { name: "Import & Continue" })).toBeInTheDocument();
    setVisible(true);
    expect(within(topBar()).queryByRole("button", { name: "Import & Continue" })).toBeNull();
  });

  test("the top-bar button keeps focus when the page's button scrolls back into view", () => {
    renderShell(<Page action={{ label: "Import & Continue", run: () => {} }} withAnchor />);
    setVisible(false);
    const button = within(topBar()).getByRole("button", { name: "Import & Continue" });
    act(() => button.focus());
    setVisible(true);
    expect(button).toBeInTheDocument();
    expect(document.activeElement).toBe(button);

    act(() => screen.getByRole("button", { name: "Switch theme" }).focus());
    expect(within(topBar()).queryByRole("button", { name: "Import & Continue" })).toBeNull();
  });

  test("a disabled action says why and counts what blocks it", () => {
    renderShell(
      <Page
        action={{ label: "Generate & open Review", run: () => {}, disabledReason: "Finish sections", blockers: 2 }}
        withAnchor={false}
      />,
      "/p/session-abc123/set-up"
    );
    const button = within(topBar()).getByRole("button", { name: /Generate & open Review/ });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("2");
    const track = screen.getByRole("navigation", { name: "Stages" });
    expect(within(track).getByText("Finish sections")).toBeInTheDocument();
  });

  test("the action leaves with the page that registered it", () => {
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>
            leave
          </button>
          {shown ? <Page action={{ label: "Export", run: () => {} }} withAnchor={false} /> : null}
        </>
      );
    }
    renderShell(<Toggle />);
    expect(within(topBar()).getByRole("button", { name: "Export" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "leave" }));
    expect(within(topBar()).queryByRole("button", { name: "Export" })).toBeNull();
  });

  test("the latest run is called, not the one captured at registration", () => {
    const calls: number[] = [];
    function Counter() {
      const [count, setCount] = useState(0);
      usePrimaryAction({ label: "Go", run: () => calls.push(count) });
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          bump
        </button>
      );
    }
    renderShell(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "bump" }));
    fireEvent.click(within(topBar()).getByRole("button", { name: "Go" }));
    expect(calls).toEqual([1]);
  });
});

describe("top bar", () => {
  beforeEach(() => {
    useAppStore.setState({
      uiLanguage: "en",
      sessionId: "session-abc123",
      currentScreen: "wizard",
      files: [{ stem: "JRTokyoSta_B1_Space" }, { stem: "JRTokyoSta_1_Opening" }] as never,
      wizardState: null,
      wizardSaveStatus: "idle",
      wizardSavedAt: null
    });
  });

  test("the breadcrumb names the station and the stage, never the session", () => {
    renderShell(null, "/p/session-abc123/set-up");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Projects/JRTokyoSta/Set up");
    expect(crumbs).not.toHaveTextContent("session-abc");
  });

  test("a page can name the station itself", () => {
    function Artwork() {
      usePageShell({ station: "東京" });
      return null;
    }
    renderShell(<Artwork />, "/illustrator");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Projects/東京/Bring in artwork");
  });

  test("save status shows on Set up only", () => {
    useAppStore.setState({ wizardSaveStatus: "saved", wizardSavedAt: new Date(2026, 8, 24, 14, 32).getTime() });
    const { unmount } = renderShell(null, "/p/session-abc123/set-up");
    expect(within(topBar()).getByRole("status")).toHaveTextContent("Saved · 14:32");
    unmount();
    renderShell(null, "/p/session-abc123/check");
    expect(within(topBar()).queryByRole("status")).toBeNull();
  });

  test("the language switch marks the current language and changes it", () => {
    renderShell(null);
    const group = screen.getByRole("group", { name: "Display language" });
    expect(within(group).getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "日本語" }));
    expect(useAppStore.getState().uiLanguage).toBe("ja");
    expect(screen.getByRole("group", { name: "表示言語" })).toBeInTheDocument();
  });

  test("a stage with a route navigates there", () => {
    renderShell(null, "/p/session-abc123/set-up");
    const track = screen.getByRole("navigation", { name: "Stages" });
    fireEvent.click(within(track).getByRole("button", { name: /1 · Bring in/ }));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Bring in");
  });
});
