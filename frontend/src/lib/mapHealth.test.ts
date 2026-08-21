import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachMapHealth, CONTEXT_RESTORE_WAIT_MS, type MapHealthHandle } from "./mapHealth";

function fakeMap(): MapHealthHandle & { emit: (type: string) => void } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    on(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    off(type, listener) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((item) => item !== listener)
      );
    },
    resize: vi.fn(),
    triggerRepaint: vi.fn(),
    emit(type) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    }
  };
}

describe("attachMapHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("remounts when the WebGL context is lost and never restored", () => {
    const map = fakeMap();
    const remount = vi.fn();
    const detach = attachMapHealth(map, { remount });

    map.emit("webglcontextlost");
    expect(remount).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CONTEXT_RESTORE_WAIT_MS - 1);
    expect(remount).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(remount).toHaveBeenCalledTimes(1);

    detach();
  });

  it("does not remount when the browser restores the context in time", () => {
    const map = fakeMap();
    const remount = vi.fn();
    const detach = attachMapHealth(map, { remount });
    const resizesBefore = (map.resize as ReturnType<typeof vi.fn>).mock.calls.length;

    map.emit("webglcontextlost");
    map.emit("webglcontextrestored");
    vi.advanceTimersByTime(CONTEXT_RESTORE_WAIT_MS + 50);

    expect(remount).not.toHaveBeenCalled();
    expect((map.resize as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(resizesBefore);
    expect(map.triggerRepaint).toHaveBeenCalled();

    detach();
  });

  it("repaints when the tab becomes visible again", () => {
    const map = fakeMap();
    const detach = attachMapHealth(map, { remount: vi.fn() });
    (map.resize as ReturnType<typeof vi.fn>).mockClear();
    (map.triggerRepaint as ReturnType<typeof vi.fn>).mockClear();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(map.resize).toHaveBeenCalled();
    expect(map.triggerRepaint).toHaveBeenCalled();

    detach();
  });

  it("does not remount after detach", () => {
    const map = fakeMap();
    const remount = vi.fn();
    const detach = attachMapHealth(map, { remount });

    map.emit("webglcontextlost");
    detach();
    vi.advanceTimersByTime(CONTEXT_RESTORE_WAIT_MS + 50);

    expect(remount).not.toHaveBeenCalled();
  });
});
