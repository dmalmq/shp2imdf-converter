"""A QGIS layer style (``.qml``) that draws a polygon layer in the colour theme's areas.

QGIS loads ``<name>.qml`` with ``<name>.shp`` by itself, so the file needs no
project around it. The XML is written by hand, in the form QGIS 3.42 saves a
categorized renderer in, because the backend's Python cannot import PyQGIS.
Whether QGIS accepts it is a question only QGIS can answer:
``test_style_files_qgis.py`` loads one in the real application.
"""

from __future__ import annotations

from xml.sax.saxutils import quoteattr

from backend.src.color_theme import ColorTheme, LayerStyle


def layer_style_xml(theme: ColorTheme, style: LayerStyle) -> str:
    """One category per area, matching all of its values, and a last one for every value the theme does not know."""
    categories = []
    symbols = []
    for index, item in enumerate(style.classes):
        values = "".join(f'<val type="string" value={quoteattr(value)}/>' for value in item.values)
        categories.append(f'<category symbol="{index}" label={quoteattr(item.area.legend)} render="true">{values}</category>')
        symbols.append(_symbol(index, item.area.hex, theme))
    other = len(style.classes)
    # QGIS draws a value that matches no category with the category whose value is empty; without one such
    # features are not drawn at all.
    categories.append(f'<category symbol="{other}" type="string" value="" label={quoteattr(theme.other.label)} render="true"/>')
    symbols.append(_symbol(other, theme.other.hex, theme))
    return (
        "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>\n"
        # Symbology only: loading the style leaves the layer's labels, forms and actions as they are.
        '<qgis version="3.34.0" styleCategories="Symbology">\n'
        f'<renderer-v2 type="categorizedSymbol" attr={quoteattr(style.field)} symbollevels="0" enableorderby="0" '
        'forceraster="0" referencescale="-1">\n'
        f"<categories>\n{_lines(categories)}</categories>\n"
        f"<symbols>\n{_lines(symbols)}</symbols>\n"
        "<rotation/>\n<sizescale/>\n"
        "</renderer-v2>\n"
        "<blendMode>0</blendMode>\n<featureBlendMode>0</featureBlendMode>\n<layerOpacity>1</layerOpacity>\n"
        "<layerGeometryType>2</layerGeometryType>\n"
        "</qgis>\n"
    )


def _lines(items: list[str]) -> str:
    return "".join(f"{item}\n" for item in items)


def _symbol(name: int, fill_hex: str, theme: ColorTheme) -> str:
    options = {
        "color": _rgba(fill_hex),
        "style": "solid",
        "outline_color": _rgba(theme.outline.hex),
        "outline_style": "solid",
        "outline_width": f"{theme.outline.width_pt:g}",
        "outline_width_unit": "Point",
        "joinstyle": "round",
    }
    body = "".join(f'<Option type="QString" name="{key}" value="{value}"/>' for key, value in options.items())
    return (
        f'<symbol type="fill" name="{name}" alpha="1" clip_to_extent="1" force_rhr="0">'
        f'<layer class="SimpleFill" enabled="1" locked="0" pass="0"><Option type="Map">{body}</Option></layer>'
        "</symbol>"
    )


def _rgba(hex_colour: str) -> str:
    red, green, blue = (int(hex_colour[index : index + 2], 16) for index in (1, 3, 5))
    return f"{red},{green},{blue},255"
