import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl";
import { useEffect, useRef } from "react";

import {
  VTILES_PROTOCOL,
  countTile,
  emptyTileStats,
  inflate,
  protocolPath,
  type Group,
  type Prepared,
  type Problem,
  type TileStats,
  type VtilesSource
} from "../../lib/vtiles";

export type PickedFeature = {
  layer: string;
  group: string;
  sourceLayer: string | null;
  geometry: string;
  properties: Record<string, unknown>;
};

type Ready = Extract<Prepared, { ok: true }>;

const HIGHLIGHT = "tile-viewer-highlight";
const HIGHLIGHT_COLOUR = "#c2410c";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** Most features a click lists; a station's stacked floors can put hundreds under one point. */
const MAX_PICKED = 25;
/** Marks a glyph range the folder lacks: reported once as `glyphs-missing`, so MapLibre's error for each range is dropped. */
const MISSING_GLYPHS = "glyph range is not in the folder";

/**
 * The map, drawn from `source` through the `vtiles` protocol. A file that is not there
 * comes back as an empty tile, as the cache means it, and is counted rather than raised.
 */
export function TileMap({
  source,
  prepared,
  on,
  showTileBoundaries,
  onStats,
  onZoom,
  onPick,
  onProblem
}: {
  source: VtilesSource;
  prepared: Ready;
  /** Each group's name and whether it is shown. */
  on: Record<string, boolean>;
  showTileBoundaries: boolean;
  onStats: (stats: TileStats) => void;
  onZoom: (zoom: number) => void;
  onPick: (features: PickedFeature[]) => void;
  onProblem: (problem: Problem) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const callbacks = useRef({ onStats, onZoom, onPick, onProblem });
  callbacks.current = { onStats, onZoom, onPick, onProblem };

  useEffect(() => {
    let stats = emptyTileStats;
    let flush = 0;
    const count = (path: string, result: Parameters<typeof countTile>[2]) => {
      stats = countTile(stats, path, result);
      if (flush) return;
      flush = requestAnimationFrame(() => {
        flush = 0;
        callbacks.current.onStats(stats);
      });
    };
    let glyphsReported = false;

    maplibregl.addProtocol(VTILES_PROTOCOL, async (request, abort) => {
      const path = protocolPath(request.url);
      const isTile = path.startsWith("tile/");
      let data: ArrayBuffer | null;
      try {
        data = await source.read(path, abort.signal);
      } catch (caught) {
        if (isTile && !abort.signal.aborted) count(path, "failed");
        throw caught;
      }
      if (data === null) {
        if (isTile) count(path, "missing");
        else if (path.startsWith("resources/fonts/")) {
          if (!glyphsReported) {
            glyphsReported = true;
            callbacks.current.onProblem({ kind: "glyphs-missing", path });
          }
          throw new Error(`${MISSING_GLYPHS}: ${path}`);
        }
        if (request.type === "json" || request.type === "image" || !isTile) throw new Error(`${path} is not in the folder`);
        return { data: new ArrayBuffer(0) };
      }
      if (request.type === "json") return { data: JSON.parse(new TextDecoder().decode(data)) };
      if (request.type === "string") return { data: new TextDecoder().decode(data) };
      if (!isTile) return { data };
      const inflated = await inflate(data);
      count(path, inflated.gzip ? "gzip" : "loaded");
      return { data: inflated.data };
    });

    const map = new maplibregl.Map({
      container: container.current!,
      style: prepared.style,
      bounds: prepared.frame ?? undefined,
      fitBoundsOptions: { padding: 40 },
      maxZoom: 23,
      validateStyle: false,
      attributionControl: false,
      localIdeographFontFamily: "'Yu Gothic UI', 'Meiryo', 'Hiragino Sans', 'Noto Sans JP', sans-serif"
    });
    mapRef.current = map;
    if (map.getZoom() < prepared.primary.minzoom) map.jumpTo({ zoom: prepared.primary.minzoom + 0.5 });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    const background = new Set(prepared.groups.filter((group) => group.background).flatMap((group) => group.layers));
    map.on("load", () => {
      map.addSource(HIGHLIGHT, { type: "geojson", data: EMPTY });
      map.addLayer({
        id: `${HIGHLIGHT}-fill`,
        type: "fill",
        source: HIGHLIGHT,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": HIGHLIGHT_COLOUR, "fill-opacity": 0.18 }
      });
      map.addLayer({ id: `${HIGHLIGHT}-line`, type: "line", source: HIGHLIGHT, paint: { "line-color": HIGHLIGHT_COLOUR, "line-width": 2.5 } });
      callbacks.current.onZoom(map.getZoom());
    });
    map.on("move", () => callbacks.current.onZoom(map.getZoom()));
    map.on("error", (event) => {
      const error = event.error;
      if (!error || error.name === "AbortError" || String(error.message).includes(MISSING_GLYPHS)) return;
      callbacks.current.onProblem({ kind: "map-error", message: error.message || String(error) });
    });
    map.on("click", (event) => {
      const { x, y } = event.point;
      const features = map.queryRenderedFeatures([
        [x - 4, y - 4],
        [x + 4, y + 4]
      ]).filter((feature) => feature.source !== HIGHLIGHT);
      callbacks.current.onPick(picked(features, prepared.groups));
      // Only the tile's piece of the shape: Esri cuts features at tile edges.
      const top = features.find((feature) => !background.has(feature.layer.id));
      (map.getSource(HIGHLIGHT) as GeoJSONSource | undefined)?.setData(
        top ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: top.geometry }] } : EMPTY
      );
    });

    return () => {
      cancelAnimationFrame(flush);
      map.remove();
      mapRef.current = null;
      maplibregl.removeProtocol(VTILES_PROTOCOL);
    };
  }, [source, prepared]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const group of prepared.groups) {
        for (const id of group.layers) {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on[group.name] ? group.visibility[id] : "none");
        }
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("styledata", apply);
  }, [on, prepared]);

  useEffect(() => {
    if (mapRef.current) mapRef.current.showTileBoundaries = showTileBoundaries;
  }, [showTileBoundaries]);

  return <div ref={container} className="absolute inset-0" data-testid="tile-viewer-map" />;
}

function picked(features: MapGeoJSONFeature[], groups: ReadonlyArray<Group>): PickedFeature[] {
  const groupOfLayer = new Map(groups.flatMap((group) => group.layers.map((id) => [id, group.name] as const)));
  const seen = new Set<string>();
  const out: PickedFeature[] = [];
  for (const feature of features) {
    const key = `${feature.layer.id}|${JSON.stringify(feature.properties)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      layer: feature.layer.id,
      group: groupOfLayer.get(feature.layer.id) ?? "",
      sourceLayer: feature.sourceLayer ?? null,
      geometry: feature.geometry.type,
      properties: feature.properties ?? {}
    });
    if (out.length === MAX_PICKED) break;
  }
  return out;
}
