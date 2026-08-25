"""Generate a simple QGIS project (.qgs) for a folder of ODC 2026 shapefiles.

Every Open Data Contest shapefile export ships one so the bundle can be opened
and checked without styling anything by hand: the layers of a floor sit in that
floor's group (top floor first), openings are red, and every Space category
code gets its own fill color.

The XML is written by hand, so the bundle never depends on a QGIS install --
:mod:`backend.src.qgis_export` shells out to PyQGIS for the richer ``.qgz`` and
raises on machines where QGIS is absent. What that generator can do and this
one cannot is read the written attributes: the category values a Space layer
needs colors for are collected while the shapefile is built and handed over in
:class:`OdcQgisLayer`.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import uuid4
from xml.sax.saxutils import escape, quoteattr

from backend.src.qgis_xml import map_units, project_document, srs_xml

# The Space attribute holding the 別表8.2.4 category code.
CATEGORY_FIELD = "category"

# Layers of one floor, legend order (first = top of the legend, drawn on top):
# points over lines over polygons, with the floor outline as the backdrop.
FLOOR_KIND_ORDER = ("Facility", "Opening", "Drawing", "Fixture", "Space", "Floor")
# Whole-site layers; they sit below every floor group.
SITE_KIND_ORDER = ("Building", "Site")

# A view flush against the data reads as clipped.
_EXTENT_MARGIN = 0.05
# Fallback span for an extent with no width or height (a single point, or one
# vertical line): degrees for a geographic CRS, metres otherwise.
_MIN_SPAN_DEGREES = 0.001
_MIN_SPAN_PROJECTED = 100.0


@dataclass(frozen=True, slots=True)
class OdcQgisLayer:
    """One written ODC shapefile, as the QGIS project should present it."""

    stem: str                   # file stem; the datasource is "./<stem>.shp"
    kind: str                   # ODC layer name ("Space", "Opening", ...)
    floor: str | None = None    # ODC floor token ("1", "B1", "M2"); None = whole site
    # (value, legend label) pairs to give one color each. Empty = single symbol.
    categories: tuple[tuple[str, str], ...] = ()
    # (xmin, ymin, xmax, ymax) as written, in the export CRS. The project opens
    # on the union of these, so the data is on screen without a Zoom to Layer.
    bounds: tuple[float, float, float, float] | None = None


@dataclass(frozen=True, slots=True)
class _Style:
    geometry: str   # "polygon" | "line" | "point"
    color: str      # "r,g,b,a"
    stroke: str     # polygon/marker outline color; unused for lines
    width: str      # millimetres: outline width, line width, or marker size


# Openings are the feature that gets checked most often (they are what connects
# spaces), so they are the one layer with a loud color.
_OPENING_RED = "227,26,28,255"
_SPACE_STROKE = "70,70,70,255"

_STYLES: dict[str, _Style] = {
    "Site": _Style("polygon", "240,240,240,60", "120,120,120,255", "0.4"),
    "Building": _Style("polygon", "189,189,189,90", "82,82,82,255", "0.4"),
    "Floor": _Style("polygon", "217,217,217,110", "115,115,115,255", "0.2"),
    "Space": _Style("polygon", "158,202,225,150", _SPACE_STROKE, "0.3"),
    "Fixture": _Style("polygon", "212,163,115,160", "138,110,80,255", "0.2"),
    "Drawing": _Style("line", "82,82,82,255", "", "0.35"),
    "Opening": _Style("line", _OPENING_RED, "", "0.8"),
    "Facility": _Style("point", "31,120,180,255", "255,255,255,255", "2.0"),
}

# Qualitative palette for category fills, cycled when a layer has more
# categories than colors.
_PALETTE = (
    "78,121,167", "242,142,43", "225,87,89", "118,183,178", "89,161,79",
    "237,201,72", "176,122,161", "255,157,167", "156,117,95", "186,176,172",
    "134,188,182", "140,209,125", "182,153,45", "73,152,148", "211,114,149",
    "121,112,110", "215,181,166", "91,143,249", "90,216,166", "246,189,22",
    "232,100,82", "109,200,236", "148,95,185", "255,152,69",
)

# <maplayer> geometry/wkbType attributes. QGIS re-derives both from the
# provider on load; they are declared because QGIS writes them.
_GEOMETRY_ATTRS = {
    "polygon": ("Polygon", "MultiPolygon"),
    "line": ("Line", "MultiLineString"),
    "point": ("Point", "Point"),
}

_FLOOR_TOKEN = re.compile(r"(B|M)?(\d+)", re.IGNORECASE)


def _floor_sort_key(token: str) -> tuple[float, str]:
    """Sort floors top-down: 3F, 2F, M2F, 1F, B1F, B2F, then unknown tokens."""
    text = token.strip().upper()
    match = _FLOOR_TOKEN.fullmatch(text)
    if not match:
        return 9999.0, text
    kind, number = (match.group(1) or "").upper(), int(match.group(2))
    if kind == "B":
        return float(number), text
    if kind == "M":
        # A mezzanine belongs between the floor it sits on and the next one up.
        return -(number - 0.5), text
    return float(-number), text


def _floor_label(token: str) -> str:
    """Group name for an ODC floor token: "1" -> "1F", "B1" -> "B1F"."""
    text = token.strip()
    return f"{text}F" if _FLOOR_TOKEN.fullmatch(text) else text


def _fill_symbol(name: str, color: str, stroke: str, width: str) -> str:
    return (
        f"<symbol alpha=\"1\" force_rhr=\"0\" name=\"{name}\" type=\"fill\" clip_to_extent=\"1\">"
        "<layer class=\"SimpleFill\" enabled=\"1\" locked=\"0\" pass=\"0\">"
        "<Option type=\"Map\">"
        f"<Option value=\"{color}\" name=\"color\" type=\"QString\"/>"
        "<Option value=\"bevel\" name=\"joinstyle\" type=\"QString\"/>"
        "<Option value=\"0,0\" name=\"offset\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"offset_unit\" type=\"QString\"/>"
        f"<Option value=\"{stroke}\" name=\"outline_color\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"outline_style\" type=\"QString\"/>"
        f"<Option value=\"{width}\" name=\"outline_width\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"outline_width_unit\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"style\" type=\"QString\"/>"
        "</Option>"
        "</layer>"
        "</symbol>"
    )


def _line_symbol(name: str, color: str, width: str) -> str:
    return (
        f"<symbol alpha=\"1\" force_rhr=\"0\" name=\"{name}\" type=\"line\" clip_to_extent=\"1\">"
        "<layer class=\"SimpleLine\" enabled=\"1\" locked=\"0\" pass=\"0\">"
        "<Option type=\"Map\">"
        "<Option value=\"round\" name=\"capstyle\" type=\"QString\"/>"
        "<Option value=\"bevel\" name=\"joinstyle\" type=\"QString\"/>"
        f"<Option value=\"{color}\" name=\"line_color\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"line_style\" type=\"QString\"/>"
        f"<Option value=\"{width}\" name=\"line_width\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"line_width_unit\" type=\"QString\"/>"
        "</Option>"
        "</layer>"
        "</symbol>"
    )


def _marker_symbol(name: str, color: str, stroke: str, size: str) -> str:
    return (
        f"<symbol alpha=\"1\" force_rhr=\"0\" name=\"{name}\" type=\"marker\" clip_to_extent=\"1\">"
        "<layer class=\"SimpleMarker\" enabled=\"1\" locked=\"0\" pass=\"0\">"
        "<Option type=\"Map\">"
        "<Option value=\"0\" name=\"angle\" type=\"QString\"/>"
        f"<Option value=\"{color}\" name=\"color\" type=\"QString\"/>"
        "<Option value=\"1\" name=\"horizontal_anchor_point\" type=\"QString\"/>"
        "<Option value=\"bevel\" name=\"joinstyle\" type=\"QString\"/>"
        "<Option value=\"circle\" name=\"name\" type=\"QString\"/>"
        "<Option value=\"0,0\" name=\"offset\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"offset_unit\" type=\"QString\"/>"
        f"<Option value=\"{stroke}\" name=\"outline_color\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"outline_style\" type=\"QString\"/>"
        "<Option value=\"0.2\" name=\"outline_width\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"outline_width_unit\" type=\"QString\"/>"
        "<Option value=\"diameter\" name=\"scale_method\" type=\"QString\"/>"
        f"<Option value=\"{size}\" name=\"size\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"size_unit\" type=\"QString\"/>"
        "<Option value=\"1\" name=\"vertical_anchor_point\" type=\"QString\"/>"
        "</Option>"
        "</layer>"
        "</symbol>"
    )


def _symbol(style: _Style, name: str, color: str) -> str:
    if style.geometry == "polygon":
        return _fill_symbol(name, color, style.stroke, style.width)
    if style.geometry == "line":
        return _line_symbol(name, color, style.width)
    return _marker_symbol(name, color, style.stroke, style.width)


def _category_color(index: int, style: _Style) -> str:
    # Fills stay translucent so the floor outline below still reads.
    alpha = 150 if style.geometry == "polygon" else 240
    return f"{_PALETTE[index % len(_PALETTE)]},{alpha}"


def _single_symbol_renderer(style: _Style) -> str:
    return (
        "<renderer-v2 forceraster=\"0\" enableorderby=\"0\" referencescale=\"-1\" "
        "symbollevels=\"0\" type=\"singleSymbol\">"
        f"<symbols>{_symbol(style, '0', style.color)}</symbols>"
        "</renderer-v2>"
    )


def _categorized_renderer(style: _Style, categories: tuple[tuple[str, str], ...]) -> str:
    entries = "".join(
        f"<category uuid=\"{index}\" value={quoteattr(value)} symbol=\"{index}\" "
        f"label={quoteattr(label)} render=\"true\" type=\"QString\"/>"
        for index, (value, label) in enumerate(categories)
    )
    symbols = "".join(
        _symbol(style, str(index), _category_color(index, style))
        for index in range(len(categories))
    )
    return (
        f"<renderer-v2 attr=\"{CATEGORY_FIELD}\" forceraster=\"0\" enableorderby=\"0\" "
        "referencescale=\"-1\" symbollevels=\"0\" type=\"categorizedSymbol\">"
        f"<categories>{entries}</categories>"
        f"<symbols>{symbols}</symbols>"
        "</renderer-v2>"
    )


def _datasource(layer: OdcQgisLayer) -> str:
    # Relative, so the extracted zip resolves without rewriting the project.
    return f"./{layer.stem}.shp"


def _layer_tree_entry(layer_id: str, layer: OdcQgisLayer) -> str:
    return (
        "<layer-tree-layer expanded=\"0\" providerKey=\"ogr\" checked=\"Qt::Checked\" "
        f"id=\"{layer_id}\" name={quoteattr(layer.kind)} "
        f"source={quoteattr(_datasource(layer))}>"
        "<customproperties><Option/></customproperties>"
        "</layer-tree-layer>"
    )


def _maplayer(layer: OdcQgisLayer, layer_id: str, srs: str, encoding: str) -> str:
    style = _STYLES[layer.kind]
    geometry, wkb = _GEOMETRY_ATTRS[style.geometry]
    renderer = (
        _categorized_renderer(style, layer.categories)
        if layer.categories
        else _single_symbol_renderer(style)
    )
    return (
        f"<maplayer type=\"vector\" geometry=\"{geometry}\" wkbType=\"{wkb}\" "
        "styleCategories=\"AllStyleCategories\" hasScaleBasedVisibilityFlag=\"0\" "
        "minScale=\"100000000\" maxScale=\"0\" readOnly=\"0\">"
        f"<id>{layer_id}</id>"
        f"<datasource>{escape(_datasource(layer))}</datasource>"
        f"<layername>{escape(layer.kind)}</layername>"
        f"<srs>{srs}</srs>"
        f"<provider encoding=\"{escape(encoding)}\">ogr</provider>"
        f"{renderer}"
        "</maplayer>"
    )


def _in_legend_order(
    layers: list[OdcQgisLayer], order: tuple[str, ...]
) -> list[OdcQgisLayer]:
    """``layers`` sorted by ``order``; kinds this project cannot style drop out."""
    ranked = [
        (order.index(layer.kind), index, layer)
        for index, layer in enumerate(layers)
        if layer.kind in order and layer.kind in _STYLES
    ]
    ranked.sort(key=lambda entry: entry[:2])
    return [layer for _rank, _index, layer in ranked]


def _padded_extent(
    bounds: tuple[float, float, float, float], geographic: bool
) -> tuple[float, float, float, float]:
    xmin, ymin, xmax, ymax = bounds
    span = max(xmax - xmin, ymax - ymin)
    if span <= 0:
        half = (_MIN_SPAN_DEGREES if geographic else _MIN_SPAN_PROJECTED) / 2
        return xmin - half, ymin - half, xmax + half, ymax + half
    pad = span * _EXTENT_MARGIN
    return xmin - pad, ymin - pad, xmax + pad, ymax + pad


def _union_bounds(
    layers: Sequence[OdcQgisLayer],
) -> tuple[float, float, float, float] | None:
    boxes = [layer.bounds for layer in layers if layer.bounds is not None]
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _view_xml(bounds: tuple[float, float, float, float], srs: str, units: str) -> str:
    """Where the project opens, so the data is on screen without a Zoom to Layer.

    ``DefaultViewExtent`` is the extent QGIS opens at and ``PresetFullExtent``
    the one Zoom Full uses; both are set, so neither route leaves the station
    off screen. ``<mapcanvas>`` is the saved-view element the GUI writes and
    restores in preference to either - it is emitted with the same extent so a
    project that has never been opened in the GUI still has one.
    """
    xmin, ymin, xmax, ymax = _padded_extent(bounds, geographic=units == "degrees")
    attrs = f"xmin=\"{xmin!r}\" ymin=\"{ymin!r}\" xmax=\"{xmax!r}\" ymax=\"{ymax!r}\""
    return (
        "<mapcanvas name=\"theMapCanvas\" annotationsVisible=\"1\">"
        f"<units>{units}</units>"
        f"<extent><xmin>{xmin!r}</xmin><ymin>{ymin!r}</ymin>"
        f"<xmax>{xmax!r}</xmax><ymax>{ymax!r}</ymax></extent>"
        "<rotation>0</rotation>"
        f"<destinationsrs>{srs}</destinationsrs>"
        "</mapcanvas>"
        "<ProjectViewSettings rotation=\"0\" UseProjectScales=\"0\">"
        "<Scales/>"
        f"<DefaultViewExtent {attrs}>{srs}</DefaultViewExtent>"
        f"<PresetFullExtent {attrs}>{srs}</PresetFullExtent>"
        "</ProjectViewSettings>"
    )


def build_odc_qgs_project(
    layers: Sequence[OdcQgisLayer],
    project_name: str,
    crs: str,
    encoding: str = "UTF-8",
) -> str:
    """Return a ``.qgs`` document for the shapefiles described by ``layers``.

    ``layers`` may arrive in any order: each one is filed under its floor and
    the floors are stacked top-down, so the tree matches how the building is
    read rather than how the files happened to be written. ``crs`` is the CRS
    the shapefiles were written in, and ``encoding`` the encoding of their DBFs.
    """
    srs = srs_xml(crs)
    by_floor: dict[str | None, list[OdcQgisLayer]] = {}
    for layer in layers:
        by_floor.setdefault(layer.floor, []).append(layer)

    tree: list[str] = []
    maplayers: list[str] = []
    layerorder: list[str] = []
    placed: list[OdcQgisLayer] = []

    def _add(layer: OdcQgisLayer) -> str:
        layer_id = f"lyr{len(maplayers):03d}_{uuid4().hex}"
        maplayers.append(_maplayer(layer, layer_id, srs, encoding))
        layerorder.append(f"<layer id=\"{layer_id}\"/>")
        placed.append(layer)
        return _layer_tree_entry(layer_id, layer)

    for token in sorted((t for t in by_floor if t is not None), key=_floor_sort_key):
        entries = "".join(
            _add(layer) for layer in _in_legend_order(by_floor[token], FLOOR_KIND_ORDER)
        )
        if entries:
            tree.append(
                f"<layer-tree-group expanded=\"1\" name={quoteattr(_floor_label(token))}>"
                f"{entries}</layer-tree-group>"
            )
    tree.extend(
        _add(layer)
        for layer in _in_legend_order(by_floor.get(None, []), SITE_KIND_ORDER)
    )

    # Only the layers actually in the tree, so a kind that dropped out cannot
    # drag the view somewhere with nothing to see.
    bounds = _union_bounds(placed)
    view = _view_xml(bounds, srs, map_units(crs)) if bounds is not None else ""

    return project_document(
        project_name,
        crs,
        f"<layer-tree-group>{''.join(tree)}<custom-order enabled=\"0\"/></layer-tree-group>"
        f"{view}"
        f"<projectlayers>{''.join(maplayers)}</projectlayers>"
        f"<layerorder>{''.join(layerorder)}</layerorder>",
    )
