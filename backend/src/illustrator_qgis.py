"""Generate a QGIS project (.qgs) for an Illustrator-derived GeoPackage.

The project references each GeoPackage layer by relative path, orders the layers
to match the Illustrator layer stack (top layer on top), and styles each layer
with a *simple* symbol whose color is **data-defined** from the per-feature
``fill_color`` (polygons) / ``stroke_color`` (lines) attribute — so the map
reproduces the original artwork colors without any manual styling.

The XML is written by hand (no PyQGIS dependency) so the conversion stays
self-contained. The structure mirrors what QGIS 3.x itself writes for a
single-symbol renderer with a data-defined color property.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4
from xml.sax.saxutils import escape, quoteattr

# Neutral fallback colors, used only when a feature's color attribute is null.
_FILL_FALLBACK = "200,200,200,255"
_OUTLINE_FALLBACK = "35,35,35,255"
_LINE_FALLBACK = "50,50,50,255"

_UNKNOWN_SRS = (
    "<spatialrefsys nativeFormat=\"Wkt\">"
    "<wkt></wkt><proj4></proj4><srsid>0</srsid><srid>0</srid>"
    "<authid></authid><description></description>"
    "<projectionacronym></projectionacronym><ellipsoidacronym></ellipsoidacronym>"
    "<geographicflag>false</geographicflag>"
    "</spatialrefsys>"
)


@dataclass(slots=True)
class QgisLayerSpec:
    """A GeoPackage table to expose as a styled QGIS layer."""

    table: str          # GeoPackage layer/table name
    display_name: str   # human-facing name (the Illustrator layer name)
    role: str           # "polygon" or "line"


def _dd_color_property(field: str) -> str:
    """Data-defined color property block (field-based, matches QGIS output)."""
    return (
        "<data_defined_properties>"
        "<Option type=\"Map\">"
        "<Option value=\"\" name=\"name\" type=\"QString\"/>"
        "<Option name=\"properties\" type=\"Map\">"
        f"<Option name=\"{field[0]}\" type=\"Map\">"
        "<Option value=\"true\" name=\"active\" type=\"bool\"/>"
        f"<Option value={quoteattr(field[1])} name=\"field\" type=\"QString\"/>"
        "<Option value=\"2\" name=\"type\" type=\"int\"/>"
        "</Option>"
        "</Option>"
        "<Option value=\"collection\" name=\"type\" type=\"QString\"/>"
        "</Option>"
        "</data_defined_properties>"
    )


def _polygon_renderer() -> str:
    dd = _dd_color_property(("fillColor", "fill_color"))
    return (
        "<renderer-v2 forceraster=\"0\" enableorderby=\"0\" referencescale=\"-1\" "
        "symbollevels=\"0\" type=\"singleSymbol\">"
        "<symbols>"
        "<symbol alpha=\"1\" force_rhr=\"0\" name=\"0\" type=\"fill\" clip_to_extent=\"1\">"
        "<layer class=\"SimpleFill\" enabled=\"1\" locked=\"0\" pass=\"0\">"
        "<Option type=\"Map\">"
        f"<Option value=\"{_FILL_FALLBACK}\" name=\"color\" type=\"QString\"/>"
        "<Option value=\"bevel\" name=\"joinstyle\" type=\"QString\"/>"
        "<Option value=\"0,0\" name=\"offset\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"offset_unit\" type=\"QString\"/>"
        f"<Option value=\"{_OUTLINE_FALLBACK}\" name=\"outline_color\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"outline_style\" type=\"QString\"/>"
        "<Option value=\"0.1\" name=\"outline_width\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"outline_width_unit\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"style\" type=\"QString\"/>"
        "</Option>"
        f"{dd}"
        "</layer>"
        "</symbol>"
        "</symbols>"
        "</renderer-v2>"
    )


def _line_renderer() -> str:
    dd = _dd_color_property(("outlineColor", "stroke_color"))
    return (
        "<renderer-v2 forceraster=\"0\" enableorderby=\"0\" referencescale=\"-1\" "
        "symbollevels=\"0\" type=\"singleSymbol\">"
        "<symbols>"
        "<symbol alpha=\"1\" force_rhr=\"0\" name=\"0\" type=\"line\" clip_to_extent=\"1\">"
        "<layer class=\"SimpleLine\" enabled=\"1\" locked=\"0\" pass=\"0\">"
        "<Option type=\"Map\">"
        "<Option value=\"round\" name=\"capstyle\" type=\"QString\"/>"
        "<Option value=\"bevel\" name=\"joinstyle\" type=\"QString\"/>"
        f"<Option value=\"{_LINE_FALLBACK}\" name=\"line_color\" type=\"QString\"/>"
        "<Option value=\"solid\" name=\"line_style\" type=\"QString\"/>"
        "<Option value=\"0.3\" name=\"line_width\" type=\"QString\"/>"
        "<Option value=\"MM\" name=\"line_width_unit\" type=\"QString\"/>"
        "</Option>"
        f"{dd}"
        "</layer>"
        "</symbol>"
        "</symbols>"
        "</renderer-v2>"
    )


def _maplayer(spec: QgisLayerSpec, layer_id: str, gpkg_filename: str) -> str:
    is_poly = spec.role == "polygon"
    geometry = "Polygon" if is_poly else "Line"
    wkb = "MultiPolygon" if is_poly else "MultiLineString"
    renderer = _polygon_renderer() if is_poly else _line_renderer()
    datasource = f"./{gpkg_filename}|layername={spec.table}"
    return (
        f"<maplayer type=\"vector\" geometry=\"{geometry}\" wkbType=\"{wkb}\" "
        "styleCategories=\"AllStyleCategories\" hasScaleBasedVisibilityFlag=\"0\" "
        "minScale=\"100000000\" maxScale=\"0\" readOnly=\"0\">"
        f"<id>{layer_id}</id>"
        f"<datasource>{escape(datasource)}</datasource>"
        f"<layername>{escape(spec.display_name)}</layername>"
        f"<srs>{_UNKNOWN_SRS}</srs>"
        "<provider encoding=\"UTF-8\">ogr</provider>"
        f"{renderer}"
        "</maplayer>"
    )


def build_qgs_project(layers: list[QgisLayerSpec], gpkg_filename: str, project_name: str) -> str:
    """Return a ``.qgs`` XML document for ``layers`` (given top-first).

    ``layers`` order is preserved as the QGIS layer-tree order (first = top of
    the stack / drawn on top), which should mirror the Illustrator layer order.
    """
    ids = [f"lyr{i:03d}_{uuid4().hex}" for i in range(len(layers))]

    tree_entries = "".join(
        f"<layer-tree-layer expanded=\"0\" providerKey=\"ogr\" checked=\"Qt::Checked\" "
        f"id=\"{lid}\" name={quoteattr(spec.display_name)} "
        f"source={quoteattr(f'./{gpkg_filename}|layername={spec.table}')}>"
        "<customproperties><Option/></customproperties>"
        "</layer-tree-layer>"
        for lid, spec in zip(ids, layers)
    )
    maplayers = "".join(_maplayer(spec, lid, gpkg_filename) for lid, spec in zip(ids, layers))
    layerorder = "".join(f"<layer id=\"{lid}\"/>" for lid in ids)

    return (
        "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>"
        f"<qgis version=\"3.34.0\" projectname={quoteattr(project_name)}>"
        f"<projectCrs>{_UNKNOWN_SRS}</projectCrs>"
        f"<layer-tree-group>{tree_entries}<custom-order enabled=\"0\"/></layer-tree-group>"
        f"<projectlayers>{maplayers}</projectlayers>"
        f"<layerorder>{layerorder}</layerorder>"
        "</qgis>"
    )
