"""Read or update one text field of a File Geodatabase, in a Python that has GDAL's ``osgeo``.

The backend's Python has pyogrio, which cannot update a geodatabase, and no
``osgeo``. ``gdb.py`` runs this file as ``python -I gdb_worker.py ...`` in an
interpreter that has it (ArcGIS Pro ships one), so it imports nothing but the
standard library and ``osgeo``.

Both directions are ASCII JSON read and written as bytes, so the console code
page never decides how a Japanese layer name crosses the pipe. Any failure
exits 1 with the error as the last line of stderr.

``read <gdb> <field> <category field>`` opens read-only and prints
``{"gdal": version, "layers": [{"name", "field_type", "width", "rows": [[fid, value, category], ...]}]}``
for every layer that has the field; a NULL cell is null.

``apply <gdb> <field>`` reads ``{"edits": {layer: {fid: text}}}`` on stdin, sets
the field on exactly those rows and prints ``{"updated": n}``. GDAL rewrites
each such row whole, geometry included, so a polygon is first regrouped by its
stored ring winding. It never runs REPACK: measured on Tokyo, REPACK rewrote
106 tables for 64 edited, deleted 105 spatial indexes, and dropped an
attribute index that ``.gdbindexes`` still declared, after which a filter on
that field raised.
"""

from __future__ import annotations

import json
import sys

from osgeo import gdal, ogr

gdal.UseExceptions()


def _open(path: str, *, update: bool) -> gdal.Dataset:
    flags = gdal.OF_VECTOR | (gdal.OF_UPDATE if update else gdal.OF_READONLY)
    return gdal.OpenEx(path, flags, allowed_drivers=["OpenFileGDB"])


def _cell(feature: ogr.Feature, index: int) -> str | None:
    if index < 0 or not feature.IsFieldSetAndNotNull(index):
        return None
    return feature.GetFieldAsString(index)


def read(path: str, field: str, category_field: str) -> dict:
    dataset = _open(path, update=False)
    layers = []
    for number in range(dataset.GetLayerCount()):
        layer = dataset.GetLayer(number)
        definition = layer.GetLayerDefn()
        index = definition.GetFieldIndex(field)
        if index < 0:
            continue
        category = definition.GetFieldIndex(category_field)
        target = definition.GetFieldDefn(index)
        layers.append(
            {
                "name": layer.GetName(),
                "field_type": target.GetFieldTypeName(target.GetType()),
                "width": target.GetWidth(),
                "rows": [[feature.GetFID(), _cell(feature, index), _cell(feature, category)] for feature in layer],
            }
        )
    return {"gdal": gdal.__version__, "layers": layers}


def _clockwise(ring: ogr.Geometry) -> bool:
    points = ring.GetPoints() or []
    return sum(x1 * y2 - x2 * y1 for (x1, y1, *_), (x2, y2, *_) in zip(points, points[1:])) < 0


def _regrouped(geometry: ogr.Geometry | None) -> ogr.Geometry | None:
    """The polygon regrouped by the winding it was stored with; None when GDAL's grouping already matches it.

    In a geodatabase a clockwise ring is filled and a counter-clockwise one is
    a hole. GDAL reads rings into polygons by containment and writes interior
    rings counter-clockwise, so a clockwise ring drawn inside another (Tokyo's
    0F floor has 26) would come back as a hole: measured, its area fell from
    31,900.75 to 25,725.10.
    """
    kind = None if geometry is None else geometry.GetGeometryType()
    if kind is None or ogr.GT_Flatten(kind) not in (ogr.wkbPolygon, ogr.wkbMultiPolygon):
        return None
    polygons = [geometry] if ogr.GT_Flatten(kind) == ogr.wkbPolygon else list(geometry)
    if all(_clockwise(ring) == (index == 0) for polygon in polygons for index, ring in enumerate(polygon)):
        return None
    groups: list[list[ogr.Geometry]] = []
    for ring in (ring for polygon in polygons for ring in polygon):
        if _clockwise(ring) or not groups:
            groups.append([ring])
        else:
            groups[-1].append(ring)
    has_z, has_m = ogr.GT_HasZ(kind), ogr.GT_HasM(kind)
    regrouped = ogr.Geometry(ogr.GT_SetModifier(ogr.wkbMultiPolygon, has_z, has_m))
    for rings in groups:
        polygon = ogr.Geometry(ogr.GT_SetModifier(ogr.wkbPolygon, has_z, has_m))
        for ring in rings:
            polygon.AddGeometry(ring)
        regrouped.AddGeometry(polygon)
    return regrouped


def apply(path: str, field: str, edits: dict[str, dict[str, str]]) -> dict:
    dataset = _open(path, update=True)
    updated = 0
    for name, rows in edits.items():
        layer = dataset.GetLayerByName(name)
        if layer is None:
            raise ValueError(f"{name} is not a layer of the geodatabase")
        index = layer.GetLayerDefn().GetFieldIndex(field)
        if index < 0:
            raise ValueError(f"{name} has no {field} field")
        target = layer.GetLayerDefn().GetFieldDefn(index)
        if target.GetType() != ogr.OFTString:
            raise ValueError(f"{name}.{field} is not a text field")
        width = target.GetWidth()
        for fid, text in rows.items():
            # GDAL enforces no width on write, so this is the refusal a DBF patch gets from its record layout.
            if width and len(text) > width:
                raise ValueError(f"{len(text)} characters do not fit {name}.{field} ({width})")
            feature = layer.GetFeature(int(fid))
            if feature is None:
                raise ValueError(f"{name} has no row {fid}")
            feature.SetField(index, text)
            regrouped = _regrouped(feature.GetGeometryRef())
            if regrouped is not None:
                feature.SetGeometry(regrouped)
            layer.SetFeature(feature)
            updated += 1
        layer.SyncToDisk()
    # Releasing the last reference closes it; older GDAL bindings have no Dataset.Close().
    dataset = layer = None
    return {"updated": updated}


# No match statement: older ArcGIS Pro releases ship Python 3.9.
def main(argv: list[str]) -> dict:
    if len(argv) == 4 and argv[0] == "read":
        return read(*argv[1:])
    if len(argv) == 3 and argv[0] == "apply":
        return apply(argv[1], argv[2], json.loads(sys.stdin.buffer.read())["edits"])
    raise ValueError(f"usage: read <gdb> <field> <category field> | apply <gdb> <field>; got {argv}")


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}".replace("\r", " ").replace("\n", " ")
        sys.stderr.buffer.write(message.encode("utf-8", "backslashreplace") + b"\n")
        sys.exit(1)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
