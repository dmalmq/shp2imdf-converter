import type { StyleSpecification } from "maplibre-gl";

import { STREET_MAP_STYLE } from "./streetMapStyle";

/**
 * Basemaps for artwork placement.
 *
 * OSM frequently has no building footprint for the site, which makes alignment
 * impossible; the GSI aerial layer shows the actual roof, and GSI's standard
 * map carries authoritative Japanese labels. Esri World Imagery is the global
 * fallback: near-nadir, high-resolution aerial/satellite mosaics that show
 * building form from above almost everywhere. GSI layers require the
 * attribution 出典：国土地理院, Esri requires "Imagery © Esri". All endpoints
 * were verified serving tiles at z17.
 */
export type BasemapId = "osm" | "gsi-photo" | "gsi-std" | "esri" | "none";

export const BASEMAP_ORDER: BasemapId[] = ["osm", "gsi-photo", "gsi-std", "esri", "none"];

/**
 * True for the photographic basemaps.
 *
 * Ghost floors are drawn as a neutral, and which neutral works depends on what
 * is underneath: near-black at 6% fill is invisible over aerial imagery, and
 * near-white is invisible over a street map. This is the only thing the paint
 * rule needs to know about the basemap.
 */
export function isImageryBasemap(id: BasemapId): boolean {
  return id === "gsi-photo" || id === "esri";
}

const GSI_ATTRIBUTION =
  '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>';

const ESRI_ATTRIBUTION =
  'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';

function rasterStyle(
  id: string,
  tiles: string[],
  attribution: string,
  maxzoom: number
): StyleSpecification {
  return {
    version: 8,
    sources: { [id]: { type: "raster", tiles, tileSize: 256, attribution, maxzoom } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#e8eef4" } },
      { id, type: "raster", source: id }
    ]
  };
}

const DRAWING_ONLY_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#f1f5f9" }
    }
  ]
};

export const BASEMAP_STYLES: Record<BasemapId, StyleSpecification> = {
  none: DRAWING_ONLY_STYLE,
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
  ),
  esri: rasterStyle(
    "esri",
    ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    ESRI_ATTRIBUTION,
    19
  )
};

export function basemapLabel(id: BasemapId, t: (en: string, ja: string) => string): string {
  if (id === "none") return t("Map off", "地図なし");
  if (id === "osm") return t("Street", "地図");
  if (id === "gsi-photo") return t("Aerial (GSI)", "写真（地理院）");
  if (id === "esri") return t("Satellite (Esri)", "衛星写真（Esri）");
  return t("GSI map", "地理院地図");
}
