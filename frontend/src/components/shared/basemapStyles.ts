import type { StyleSpecification } from "maplibre-gl";

import { STREET_MAP_STYLE } from "./streetMapStyle";

/**
 * Basemaps for artwork placement.
 *
 * OSM frequently has no building footprint for the site, which makes alignment
 * impossible; the GSI aerial layer shows the actual roof, and GSI's standard
 * map carries authoritative Japanese labels. Both require the attribution
 * 出典：国土地理院. All three endpoints were verified serving tiles at z17.
 */
export type BasemapId = "osm" | "gsi-photo" | "gsi-std";

export const BASEMAP_ORDER: BasemapId[] = ["osm", "gsi-photo", "gsi-std"];

const GSI_ATTRIBUTION =
  '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>';

function rasterStyle(
  id: string,
  tiles: string[],
  attribution: string,
  maxzoom: number
): StyleSpecification {
  return {
    version: 8,
    sources: { [id]: { type: "raster", tiles, tileSize: 256, attribution, maxzoom } },
    layers: [{ id, type: "raster", source: id }]
  };
}

export const BASEMAP_STYLES: Record<BasemapId, StyleSpecification> = {
  osm: STREET_MAP_STYLE,
  "gsi-photo": rasterStyle(
    "gsi-photo",
    ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
    GSI_ATTRIBUTION,
    18
  ),
  "gsi-std": rasterStyle(
    "gsi-std",
    ["https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"],
    GSI_ATTRIBUTION,
    18
  )
};

export function basemapLabel(id: BasemapId, t: (en: string, ja: string) => string): string {
  if (id === "osm") return t("Street", "地図");
  if (id === "gsi-photo") return t("Aerial (GSI)", "写真（地理院）");
  return t("GSI map", "地理院地図");
}
