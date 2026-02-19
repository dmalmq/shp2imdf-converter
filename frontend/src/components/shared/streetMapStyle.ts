import type { StyleSpecification } from "maplibre-gl";


export const STREET_MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "osm-raster": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors"
    }
  },
  layers: [
    {
      id: "osm-raster",
      type: "raster",
      source: "osm-raster"
    }
  ]
};
