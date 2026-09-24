/**
 * The `warning` / `warning-foreground` tokens from `index.css`, as literals for
 * MapLibre, whose paint expressions cannot resolve `hsl(var(--warning))`.
 *
 * These are the light values in both themes. The OSM and imagery tiles do not
 * follow the theme, so the light values match what is usually underneath. The
 * exception is the review map with its basemap off in dark mode, which shows
 * the dark `MAP_BACKGROUND`: the stroke still reads there, and map labels
 * carry their own halo, so they do not depend on the background.
 *
 * Change these together with the CSS tokens, or the map and the panels beside
 * it will disagree about what a warning looks like.
 */
export const WARNING_MAP_COLORS = {
  /** `--warning` (light): outlines, fills, markers. */
  stroke: "#ca8a04",
  /** `--warning-foreground` (light): labels drawn on the map. */
  text: "#854d0e",
  /** Label halo, the lightest step of the same yellow. */
  halo: "#fefce8"
} as const;
