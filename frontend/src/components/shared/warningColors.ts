/**
 * The `warning` / `warning-foreground` tokens from `index.css`, as literals for
 * MapLibre, whose paint expressions cannot resolve `hsl(var(--warning))`.
 *
 * Maps draw on a light basemap in both themes, so these are the light values.
 * Change them together with the CSS tokens or the map and the panels beside it
 * will disagree about what a warning looks like.
 */
export const WARNING_MAP_COLORS = {
  /** `--warning` (light): outlines, fills, markers. */
  stroke: "#ca8a04",
  /** `--warning-foreground` (light): labels drawn on the map. */
  text: "#a16207",
  /** Label halo, the lightest step of the same yellow. */
  halo: "#fefce8"
} as const;
