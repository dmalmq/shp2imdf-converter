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


def _srs_xml(crs: str | None) -> str:
    """A QGIS ``<spatialrefsys>`` block for ``crs``, or the unknown-CRS block."""
    if not crs:
        return _UNKNOWN_SRS

    from pyproj import CRS as _PyprojCRS  # local import keeps module import cheap

    parsed = _PyprojCRS.from_user_input(crs)
    authority = parsed.to_authority()
    authid = f"{authority[0]}:{authority[1]}" if authority else crs
    srid = authority[1] if authority else "0"
    return (
        '<spatialrefsys nativeFormat="Wkt">'
        f"<wkt>{escape(parsed.to_wkt())}</wkt><proj4>{escape(parsed.to_proj4())}</proj4>"
        f"<srsid>{escape(str(srid))}</srsid><srid>{escape(str(srid))}</srid>"
        f"<authid>{escape(authid)}</authid>"
        f"<description>{escape(parsed.name)}</description>"
        "<projectionacronym></projectionacronym><ellipsoidacronym></ellipsoidacronym>"
        f"<geographicflag>{'true' if parsed.is_geographic else 'false'}</geographicflag>"
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


def _layer_tree_entry(layer_id: str, spec: QgisLayerSpec, gpkg_filename: str) -> str:
    return (
        f"<layer-tree-layer expanded=\"0\" providerKey=\"ogr\" checked=\"Qt::Checked\" "
        f"id=\"{layer_id}\" name={quoteattr(spec.display_name)} "
        f"source={quoteattr(f'./{gpkg_filename}|layername={spec.table}')}>"
        "<customproperties><Option/></customproperties>"
        "</layer-tree-layer>"
    )


def _maplayer(spec: QgisLayerSpec, layer_id: str, gpkg_filename: str, srs_xml: str) -> str:
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
        f"<srs>{srs_xml}</srs>"
        "<provider encoding=\"UTF-8\">ogr</provider>"
        f"{renderer}"
        "</maplayer>"
    )


def build_qgs_project(
    layers: list[QgisLayerSpec],
    gpkg_filename: str,
    project_name: str,
    crs: str | None = None,
    layer_groups: list[tuple[str, list[QgisLayerSpec]]] | None = None,
) -> str:
    """Return a ``.qgs`` XML document for ``layers`` (given top-first).

    ``layers`` order is preserved as the QGIS layer-tree order (first = top of
    the stack / drawn on top), which should mirror the Illustrator layer order.
    ``crs`` names the authority code (e.g. ``"EPSG:6677"``) the project and
    every layer declare; ``None`` keeps the previous ungeoreferenced output.
    ``layer_groups``, when given, wraps the layers in named ``<layer-tree-group>``
    elements (one per ``(name, specs)`` pair) instead of a flat tree; the
    ``<projectlayers>`` block stays flat either way. ``layers`` is ignored when
    ``layer_groups`` is provided.
    """
    srs_xml = _srs_xml(crs)
    if layer_groups is not None:
        flat = [spec for _name, specs in layer_groups for spec in specs]
        ids = [f"lyr{i:03d}_{uuid4().hex}" for i in range(len(flat))]
        id_iter = iter(ids)
        tree_entries = "".join(
            f"<layer-tree-group expanded=\"1\" name={quoteattr(group_name)}>"
            + "".join(
                _layer_tree_entry(next(id_iter), spec, gpkg_filename) for spec in specs
            )
            + "</layer-tree-group>"
            for group_name, specs in layer_groups
        )
        maplayers = "".join(
            _maplayer(spec, lid, gpkg_filename, srs_xml) for lid, spec in zip(ids, flat)
        )
        layerorder = "".join(f"<layer id=\"{lid}\"/>" for lid in ids)
    else:
        ids = [f"lyr{i:03d}_{uuid4().hex}" for i in range(len(layers))]
        tree_entries = "".join(
            _layer_tree_entry(lid, spec, gpkg_filename) for lid, spec in zip(ids, layers)
        )
        maplayers = "".join(
            _maplayer(spec, lid, gpkg_filename, srs_xml) for lid, spec in zip(ids, layers)
        )
        layerorder = "".join(f"<layer id=\"{lid}\"/>" for lid in ids)

    return (
        "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>"
        f"<qgis version=\"3.34.0\" projectname={quoteattr(project_name)}>"
        f"<projectCrs>{srs_xml}</projectCrs>"
        f"<layer-tree-group>{tree_entries}<custom-order enabled=\"0\"/></layer-tree-group>"
        f"<projectlayers>{maplayers}</projectlayers>"
        f"<layerorder>{layerorder}</layerorder>"
        "</qgis>"
    )
