import type { StyleSpecification } from "maplibre-gl";

/**
 * What shows under the tiles.
 *
 * Turning the basemap off is a normal way to read geometry, and it used to
 * leave a hard light slab on a dark page. The OSM raster itself cannot follow
 * the theme — those are somebody else's tiles — but this can.
 */
export const MAP_BACKGROUND = { light: "#e8eef4", dark: "#171717" };


export const STREET_MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "osm-raster": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": MAP_BACKGROUND.light }
    },
    {
      id: "osm-raster",
      type: "raster",
      source: "osm-raster"
    }
  ]
};
