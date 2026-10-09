"""Run inside QGIS's own Python: open shapefiles the way a user does and write down how QGIS will draw them.

usage: python-qgis.bat qgis_style_probe.py <qgis prefix> <out.json> <layer.shp> [<layer.shp> ...]

A layer opened by path loads the ``.qml`` of the same name by itself, so
nothing here applies a style. For each layer the JSON holds the renderer
QGIS ended up with, and the symbol it picks for every feature.
"""

import json
import sys

from qgis.core import NULL, QgsApplication, QgsRenderContext, QgsUnitTypes, QgsVectorLayer


def colours(symbol):
    (fill,) = symbol.symbolLayers()
    return {
        "layer": fill.layerType(),
        "fill": fill.fillColor().name().upper(),
        "outline": fill.strokeColor().name().upper(),
        "width": fill.strokeWidth(),
        "unit": QgsUnitTypes.encodeUnit(fill.strokeWidthUnit()),
    }


def describe(path):
    layer = QgsVectorLayer(path, "probe", "ogr")
    if not layer.isValid():
        return {"valid": False}
    renderer = layer.renderer()
    described = {"valid": True, "renderer": renderer.type(), "geometry": layer.geometryType().name}
    if renderer.type() != "categorizedSymbol":
        return described
    field = renderer.classAttribute()
    described["field"] = field
    described["categories"] = [
        {
            "label": category.label(),
            "values": category.value() if isinstance(category.value(), list) else [category.value()],
            **colours(category.symbol()),
        }
        for category in renderer.categories()
    ]
    context = QgsRenderContext()
    renderer.startRender(context, layer.fields())
    described["features"] = []
    for feature in layer.getFeatures():
        symbol = renderer.symbolForFeature(feature, context)
        described["features"].append(
            {
                "value": None if feature[field] == NULL else feature[field],
                # No symbol means QGIS would not draw the feature at all.
                "fill": None if symbol is None else colours(symbol)["fill"],
            }
        )
    renderer.stopRender(context)
    return described


QgsApplication.setPrefixPath(sys.argv[1], True)
app = QgsApplication([], False)
app.initQgis()
result = {path: describe(path) for path in sys.argv[3:]}
with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump(result, out, default=str)
app.exitQgis()
