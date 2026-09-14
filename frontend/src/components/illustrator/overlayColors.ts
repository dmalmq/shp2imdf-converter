/**
 * Colours for the control-point overlay, shared by the map layers and the legend
 * that explains them.
 *
 * They live here because the two drifted trivially easily: the legend hard-coded
 * the same three hex values the MapLibre paint objects did, so a change to one
 * silently left the other describing the old map.
 *
 * MapLibre paint expressions take plain colour strings, not `hsl(var(--token))`,
 * so these cannot be Tailwind classes — the CSS custom property is not resolvable
 * inside a WebGL style. Keep them in step with the `Map objects` page in Figma.
 */
export const OVERLAY_COLORS = {
  /** The point you place on the artwork. */
  artwork: "#2563eb",
  /** The point on the map it has to land on. */
  reference: "#f59e0b",
  /** The error between the two — the only red thing on the map. */
  residual: "#dc2626",
  /** Halo so a marker stays visible over dark basemap tiles. */
  halo: "#ffffff"
} as const;
