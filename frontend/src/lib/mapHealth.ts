/**
 * MapLibre paints into a WebGL canvas. On this shared Windows box the GPU
 * (or Chrome's GPU process) can drop that context after sleep, a driver
 * reset, or too many maps. MapLibre stops its render loop and the canvas
 * goes white; `webglcontextrestored` often never arrives, so we remount.
 *
 * The library also skips the first ResizeObserver callback, so a map that
 * mounts before its flex parent has a height can stay at the 400×300
 * fallback forever. A follow-up resize after layout closes that hole.
 */

export const CONTEXT_RESTORE_WAIT_MS = 800;

export type MapHealthHandle = {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  resize(): void;
  triggerRepaint(): void;
};

export type MapHealthOptions = {
  remount: () => void;
  restoreWaitMs?: number;
};

export function attachMapHealth(map: MapHealthHandle, options: MapHealthOptions): () => void {
  const wait = options.restoreWaitMs ?? CONTEXT_RESTORE_WAIT_MS;
  let lost = false;
  let detached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let raf1 = 0;
  let raf2 = 0;

  const safeRepaint = () => {
    if (detached) {
      return;
    }
    try {
      map.resize();
      map.triggerRepaint();
    } catch {
      // The map was removed between the event and this tick.
    }
  };

  const onLost = () => {
    lost = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (lost && !detached) {
        options.remount();
      }
    }, wait);
  };

  const onRestored = () => {
    lost = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    safeRepaint();
  };

  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    safeRepaint();
  };

  map.on("webglcontextlost", onLost);
  map.on("webglcontextrestored", onRestored);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onVisible);
  window.addEventListener("focus", onVisible);

  safeRepaint();
  raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(safeRepaint);
  });

  return () => {
    if (detached) {
      return;
    }
    detached = true;
    lost = false;
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (raf1) {
      cancelAnimationFrame(raf1);
    }
    if (raf2) {
      cancelAnimationFrame(raf2);
    }
    map.off("webglcontextlost", onLost);
    map.off("webglcontextrestored", onRestored);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}
