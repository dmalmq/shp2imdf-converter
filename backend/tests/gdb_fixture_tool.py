"""Build and look inside File Geodatabases for the colour tool's tests, in the same Python as ``gdb_worker.py``.

Never through pyogrio: it cannot set a text field's width or create an
attribute index, and the tests exist to catch width and index defects.
Standard library and ``osgeo`` only, run as ``python -I gdb_fixture_tool.py``.

``build <gdb>`` reads a spec on stdin:
``{"classes": [{"name", "dataset": str|null, "fields": [[name, width], ...], "index": [field, ...], "rows": [{field: text|null}]}]}``.
Every field is text. Each row gets its own square MultiPolygon ZM, every
class a spatial index plus ``Shape_Length``/``Shape_Area``, and every field
named in ``index`` an attribute index.

``dump <gdb>`` prints every layer's field widths and rows (``fid``, every field, ISO WKB hex),
and the file stem of every table (``a00000009`` for the catalog's row 9).
``filter <gdb> <layer> <where>`` prints the FIDs an attribute filter returns.
"""

from __future__ import annotations

import json
import sys

from osgeo import gdal, ogr, osr

gdal.UseExceptions()


def _square(index: int) -> ogr.Geometry:
    x, y = (index % 50) * 10.0, (index // 50) * 10.0
    ring = f"{x} {y} 3 0,{x} {y + 8} 3 1,{x + 8} {y + 8} 3 2,{x + 8} {y} 3 3,{x} {y} 3 0"
    return ogr.CreateGeometryFromWkt(f"MULTIPOLYGON ZM ((({ring})))")


def build(path: str, spec: dict) -> dict:
    dataset = gdal.GetDriverByName("OpenFileGDB").Create(path, 0, 0, 0, gdal.GDT_Unknown)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    for number, item in enumerate(spec["classes"]):
        options = ["CREATE_SHAPE_AREA_AND_LENGTH_FIELDS=YES"]
        if item.get("dataset"):
            options.append(f"FEATURE_DATASET={item['dataset']}")
        layer = dataset.CreateLayer(item["name"], srs, ogr.wkbMultiPolygonZM, options)
        for name, width in item["fields"]:
            definition = ogr.FieldDefn(name, ogr.OFTString)
            definition.SetWidth(width)
            layer.CreateField(definition)
        for index, row in enumerate(item["rows"]):
            feature = ogr.Feature(layer.GetLayerDefn())
            for name, value in row.items():
                if value is None:
                    feature.SetFieldNull(name)
                else:
                    feature.SetField(name, value)
            feature.SetGeometry(_square(index))
            layer.CreateFeature(feature)
        for field in item.get("index", []):
            # The driver's parser takes quotes as part of the name, and index names must be ASCII.
            dataset.ExecuteSQL(f"CREATE INDEX ix{number}_{field} ON {item['name']}({field})")
    dataset = None
    return {"built": path}


def dump(path: str) -> dict:
    dataset = gdal.OpenEx(path, gdal.OF_VECTOR, allowed_drivers=["OpenFileGDB"])
    layers = {}
    for number in range(dataset.GetLayerCount()):
        layer = dataset.GetLayer(number)
        definition = layer.GetLayerDefn()
        names = [definition.GetFieldDefn(i).GetName() for i in range(definition.GetFieldCount())]
        rows = []
        for feature in layer:
            geometry = feature.GetGeometryRef()
            rows.append(
                {
                    "fid": feature.GetFID(),
                    "fields": {name: feature.GetField(name) for name in names},
                    "wkb": None if geometry is None else bytes(geometry.ExportToIsoWkb()).hex(),
                }
            )
        widths = {definition.GetFieldDefn(i).GetName(): definition.GetFieldDefn(i).GetWidth() for i in range(len(names))}
        layers[layer.GetName()] = {"widths": widths, "rows": rows}
    catalog = gdal.OpenEx(path, gdal.OF_VECTOR, allowed_drivers=["OpenFileGDB"], open_options=["LIST_ALL_TABLES=YES"])
    # A table's files are named after its row in the catalog: row 9 is a00000009.gdbtable and its siblings.
    tables = {feature.GetField("Name"): f"a{feature.GetFID():08x}" for feature in catalog.GetLayerByName("GDB_SystemCatalog")}
    return {"layers": layers, "tables": tables}


def where(path: str, layer_name: str, clause: str) -> dict:
    dataset = gdal.OpenEx(path, gdal.OF_VECTOR, allowed_drivers=["OpenFileGDB"])
    layer = dataset.GetLayerByName(layer_name)
    layer.SetAttributeFilter(clause)
    return {"fids": sorted(feature.GetFID() for feature in layer)}


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    if command == "build":
        result = build(args[0], json.loads(sys.stdin.buffer.read()))
    elif command == "dump":
        result = dump(args[0])
    elif command == "filter":
        result = where(*args)
    else:
        raise SystemExit(f"unknown command {command}")
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
