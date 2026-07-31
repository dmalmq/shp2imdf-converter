#!/usr/bin/env python3
"""
generate_qgis_project.py
========================
Turn a flat open-data indoor-map shapefile folder into a styled QGIS project
(.qgz): floors grouped in the layer tree, spaces colored by category, sensible
symbology for every feature type.

Run it with QGIS's own Python (so the C++ libs resolve):

    "C:\\Program Files\\QGIS 3.42.0\\bin\\python-qgis.bat" generate_qgis_project.py \
        --input  "Q:\\...\\JRTokyoSta_6677.shp" \
        --output "Q:\\...\\JRTokyoSta_6677_auto.qgz"

Options:
    --station PREFIX   Only layers whose stem starts with PREFIX (e.g. JRTokyoSta).
                       If omitted, the most common prefix in the folder is used.
    --color-field F    Field used to categorize Space fills (default: category).
    --no-color         Skip categorization; everything gets a plain single symbol.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter, defaultdict

from qgis.core import (
    QgsApplication,
    QgsCategorizedSymbolRenderer,
    QgsProject,
    QgsRendererCategory,
    QgsSymbol,
    QgsVectorLayer,
    QgsSingleSymbolRenderer,
    QgsWkbTypes,
)

# Geometry-type enum lookup (point/line/polygon) for symbol construction.
_GEOM = {"point": QgsWkbTypes.PointGeometry,
         "line": QgsWkbTypes.LineGeometry,
         "polygon": QgsWkbTypes.PolygonGeometry}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Feature types we recognise, longest first so "Floor_Connect" wins over "Floor".
FEATURE_TYPES = [
    "Floor_Connect", "Facility", "Occupant", "Opening", "Drawing",
    "Fixture", "Segment", "Space", "Floor", "Building", "Site",
]

# Geometry hint + default single-symbol style for each type.
DEFAULT_STYLE = {
    "Floor":        dict(geom="polygon", color="#d9d9d9", alpha=80,   width=0.2),  # footprint background
    "Space":        dict(geom="polygon", color="#9ecae1", alpha=140,  width=0.3),  # overridden by categorizer
    "Fixture":      dict(geom="polygon", color="#d4a373", alpha=160,  width=0.2),
    "Drawing":      dict(geom="line",   color="#525252", alpha=255,  width=0.35), # walls
    "Opening":      dict(geom="line",   color="#ffffff", alpha=255,  width=0.8),  # door gaps
    "Facility":     dict(geom="point",  color="#1f78b4", size=2.0),
    "Occupant":     dict(geom="point",  color="#33a02c", size=1.8),
    "Floor_Connect":dict(geom="line",   color="#e7298a", alpha=220,  width=0.5),  # network
    "Segment":      dict(geom="line",   color="#1b9e77", alpha=220,  width=0.5),  # network
    "Building":     dict(geom="polygon", color="#bdbdbd", alpha=40,  width=0.4),
    "Site":         dict(geom="polygon", color="#f0f0f0", alpha=30,  width=0.4),
}

# Network layers go inside a per-floor "nw" subgroup (matches the reference file).
NETWORK_TYPES = {"Floor_Connect", "Segment"}

# Qualitative palette for category fills.
PALETTE = [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948",
    "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bcb6", "#8cd17d",
    "#b6992d", "#499894", "#d37295", "#79706e", "#d7b5a6", "#5b8ff9",
    "#5ad8a6", "#f6bd16", "#e86452", "#6dc8ec", "#945fb9", "#ff9845",
]


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def parse_stem(stem: str):
    """Return (station, floor, feature_type) or None if not an indoor-map layer."""
    for ft in FEATURE_TYPES:
        suffix = "_" + ft
        if stem.endswith(suffix):
            base = stem[: -len(suffix)]          # '<station>_<floor>'
            if "_" not in base:
                return None                       # malformed
            floor = base.rsplit("_", 1)[-1]
            station = base[: -len(floor) - 1]
            return station, floor, ft
    return None


def floor_sort_key(token: str):
    """Sort key so floors render top->bottom: 3F, 2F, M2, 1F, 0F, B1, B2 ..."""
    t = token.strip()
    b = re.match(r"^B(\d+)", t)              # basement: B1 -> after ground
    if b:
        return int(b.group(1)), 0
    mm = re.match(r"^M(\d+)", t)             # mezzanine: M2 -> between 1 and 2
    if mm:
        return -(int(mm.group(1)) - 0.5), 0
    m = re.match(r"^(\d+)", t)               # upper/ground: "3", "3F", "0F"
    if m:
        return -int(m.group(1)), 0
    return 9999, t                            # unknown -> bottom


def discover(folder: str, station: str | None):
    """Scan folder; return (floors, top_level).

    floors: {floor_token: {feature_type: abs_path}}
    top_level: {feature_type: abs_path}  (Building/Site, no floor)
    """
    floors: dict[str, dict[str, str]] = defaultdict(dict)
    top_level: dict[str, str] = {}
    prefix_counts = Counter()

    all_stems = []
    for fn in os.listdir(folder):
        if not fn.lower().endswith(".shp"):
            continue
        stem = os.path.splitext(fn)[0]
        parsed = parse_stem(stem)
        if not parsed:
            continue
        st, fl, ft = parsed
        prefix_counts[st] += 1
        all_stems.append((os.path.join(folder, fn), st, fl, ft))

    if station is None:
        station = prefix_counts.most_common(1)[0][0] if prefix_counts else ""

    for path, st, fl, ft in all_stems:
        if st != station:
            continue
        if ft in ("Building", "Site"):
            top_level[ft] = path
        else:
            floors[fl][ft] = path

    return dict(floors), top_level, station


# ---------------------------------------------------------------------------
# Symbology helpers
# ---------------------------------------------------------------------------

def _alpha_color(hex_color: str, alpha: int):
    from qgis.PyQt.QtGui import QColor
    c = QColor(hex_color)
    c.setAlpha(alpha)
    return c

def default_renderer(ft: str, geom_type):
    """Single-symbol renderer; symbol TYPE follows the layer's real geometry,
    color/size come from DEFAULT_STYLE[ft]. Robust to e.g. Floor_Connect being
    points in one dataset and lines in another."""
    from qgis.PyQt.QtGui import QColor
    cfg = DEFAULT_STYLE.get(ft, dict(geom="line", color="#999999", alpha=200, width=0.4))
    sym = QgsSymbol.defaultSymbol(geom_type)
    sym.setColor(_alpha_color(cfg["color"], cfg.get("alpha", 200)))
    if geom_type == QgsWkbTypes.PolygonGeometry:
        sym.symbolLayer(0).setStrokeColor(QColor("#404040"))
        sym.symbolLayer(0).setStrokeWidth(cfg.get("width", 0.3))
    elif geom_type == QgsWkbTypes.LineGeometry:
        sym.setWidth(cfg.get("width", 0.4))
    else:  # point
        sym.setSize(cfg.get("size", 2.0))
    return QgsSingleSymbolRenderer(sym)


def categorize(layer: QgsVectorLayer, field: str):
    """Attach a categorized renderer keyed on `field`, cycling PALETTE.
    Symbol geometry is read from the layer itself."""
    from qgis.PyQt.QtGui import QColor

    idx = layer.fields().indexFromName(field)
    if idx < 0:
        return False
    geom = layer.geometryType()
    is_poly = geom == QgsWkbTypes.PolygonGeometry
    is_point = geom == QgsWkbTypes.PointGeometry
    values = sorted({f[field] for f in layer.getFeatures()}, key=lambda v: (v is None, str(v)))

    categories = []
    for i, val in enumerate(values):
        base = QColor(PALETTE[i % len(PALETTE)])
        sym = QgsSymbol.defaultSymbol(geom)
        c = QColor(base)
        c.setAlpha(150 if is_poly else 240)
        sym.setColor(c)
        if is_poly:
            sym.symbolLayer(0).setStrokeColor(QColor(base).darker(140))
            sym.symbolLayer(0).setStrokeWidth(0.3)
        elif is_point:
            sym.setSize(2.2)
        label = str(val) if val not in (None, "") else "(empty)"
        categories.append(QgsRendererCategory(val, sym, label))
    layer.setRenderer(QgsCategorizedSymbolRenderer(field, categories))
    return True


# ---------------------------------------------------------------------------
# Project builder
# ---------------------------------------------------------------------------

def add_layer(project, path, name):
    layer = QgsVectorLayer(path, name, "ogr")
    if not layer.isValid():
        print(f"  ! skip invalid layer: {name}", file=sys.stderr)
        return None
    project.addMapLayer(layer, addToLegend=False)
    return layer


def build_project(folder: str, out_path: str, station: str | None,
                  color_field: str, do_color: bool):
    floors, top_level, station = discover(folder, station)
    if not floors and not top_level:
        raise SystemExit(f"No indoor-map layers found in {folder}")

    project = QgsProject.instance()
    project.clear()
    root = project.layerTreeRoot()

    def style(ft: str, lyr):
        if do_color and ft in ("Space", "Facility") and categorize(lyr, color_field):
            return
        lyr.setRenderer(default_renderer(ft, lyr.geometryType()))

    def place(ft: str, lyr):
        (net_group if ft in NETWORK_TYPES else group).addLayer(lyr)

    # Top-level footprints first (bottom of legend).
    for ft in ("Site", "Building"):
        lyr = add_layer(project, top_level[ft], f"{station}_{ft}") if ft in top_level else None
        if lyr:
            style(ft, lyr)
            root.addLayer(lyr)

    # One group per floor, top floor first.
    for floor in sorted(floors, key=floor_sort_key):
        group = root.addGroup(str(floor))
        net_group = group.addGroup("nw")
        parts = floors[floor]

        # Legend order: Floor (background) -> content -> network.
        order = ["Floor", "Space", "Facility", "Occupant", "Opening",
                 "Drawing", "Fixture", "Floor_Connect", "Segment"]
        for ft in order:
            path = parts.get(ft)
            if not path:
                continue
            lyr = add_layer(project, path, f"{station}_{floor}_{ft}")
            if not lyr:
                continue
            style(ft, lyr)
            place(ft, lyr)

    # Inherit CRS from the first vector layer so everything aligns.
    layers = list(project.mapLayers().values())
    if layers:
        project.setCrs(layers[0].crs())

    if not project.write(out_path):
        raise SystemExit(f"Failed to write {out_path}")
    print(f"OK  wrote {out_path}")
    print(f"    station={station}  floors={len(floors)}  layers={len(layers)}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Build a styled .qgz from a flat open-data shapefile folder.")
    ap.add_argument("--input", required=True, help="folder of *.shp (flat layout)")
    ap.add_argument("--output", required=True, help="output .qgz path")
    ap.add_argument("--station", default=None, help="station prefix filter (default: most common)")
    ap.add_argument("--color-field", default="category", help="categorize Space/Facility by this field")
    ap.add_argument("--no-color", action="store_true", help="plain single symbols only")
    args = ap.parse_args()

    app = QgsApplication([], False)
    app.initQgis()
    try:
        build_project(args.input, args.output, args.station,
                      args.color_field, not args.no_color)
    finally:
        app.exitQgis()


if __name__ == "__main__":
    main()
