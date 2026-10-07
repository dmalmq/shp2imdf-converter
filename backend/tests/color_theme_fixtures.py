"""Station uploads for the colour tool, built from raw bytes.

Never through geopandas: a geopandas write would itself change widths and
types and hide the defects the tests exist to catch. .shp and .shx contents
are arbitrary bytes on purpose, since the tool must never read them.
"""

from __future__ import annotations

from collections.abc import Sequence
import copy
from io import BytesIO
import json
from pathlib import Path
from typing import Any
import zipfile

Field = tuple[str, str, int, int]
"""(name, dBASE type, width, decimals)"""

SPACE_FIELDS: list[Field] = [
    ("name", "C", 20, 0),
    ("category", "C", 10, 0),
    ("floor", "N", 4, 0),
    ("color", "C", 254, 0),
    ("color2", "C", 254, 0),
    ("updated", "D", 8, 0),
]


def make_dbf(
    fields: Sequence[Field],
    rows: Sequence[Sequence[bytes | None]],
    *,
    deleted: frozenset[int] = frozenset(),
    language_driver: int = 0,
    pad: bytes = b" ",
) -> bytes:
    """A dBASE III table. Cells are pre-encoded bytes, left-aligned and padded with ``pad``; None is all padding."""
    header_length = 32 + 32 * len(fields) + 1
    record_length = 1 + sum(width for _, _, width, _ in fields)
    header = bytearray(32)
    header[0] = 0x03
    header[1:4] = bytes([126, 10, 6])
    header[4:8] = len(rows).to_bytes(4, "little")
    header[8:10] = header_length.to_bytes(2, "little")
    header[10:12] = record_length.to_bytes(2, "little")
    header[29] = language_driver
    for name, kind, width, decimals in fields:
        descriptor = bytearray(32)
        descriptor[:11] = name.encode("ascii").ljust(11, b"\x00")
        descriptor[11] = ord(kind)
        descriptor[16] = width
        descriptor[17] = decimals
        header += descriptor
    header += b"\x0d"
    body = bytearray()
    for index, row in enumerate(rows):
        body += b"*" if index in deleted else b" "
        for (_, _, width, _), cell in zip(fields, row, strict=True):
            cell = cell or b""
            assert len(cell) <= width
            body += cell.ljust(width, pad)
    return bytes(header + body + b"\x1a")


def space_row(color2: str, category: str, codec: str = "utf-8", *, color: str = "白", name: str = "room") -> list[bytes]:
    return [
        name.encode(codec),
        category.encode(codec),
        b"   1",
        color.encode(codec),
        color2.encode(codec),
        b"20260601",
    ]


def make_zip(members: Sequence[tuple[str, bytes | None]], *, cp932_names: bool = False) -> bytes:
    """None data writes a directory entry. ``cp932_names`` writes flagless cp932 names, as Japanese Windows does."""
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in members:
            info = _Cp932ZipInfo(name) if cp932_names else zipfile.ZipInfo(name)
            info.date_time = (2024, 5, 30, 12, 0, 0)
            if data is None:
                info.external_attr = 0o40755 << 16 | 0x10
                archive.writestr(info, b"")
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
    return buffer.getvalue()


class _Cp932ZipInfo(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):  # noqa: N802
        return self.filename.encode("cp932"), self.flag_bits


def read_zip(payload: bytes) -> dict[str, bytes | None]:
    """Member name (decoded the way the app decodes it) to data, in archive order; directories map to None."""
    from backend.src.importer import zip_member_name

    with zipfile.ZipFile(BytesIO(payload)) as archive:
        return {
            zip_member_name(info): None if info.is_dir() else archive.read(info) for info in archive.infolist()
        }


SPACE_0 = [
    space_row("ラチ外白", "B999"),
    space_row("濃鼠", "B999"),
    space_row("道白", "B029"),
    space_row("白", "B021"),
]
SPACE_1 = [
    space_row("黄", "B999"),
    space_row("トイレ", "B008"),
    space_row("濃鼠", "B010"),
    space_row("薄鼠", "B022"),
    space_row("緑", "B999"),
]


def station_members() -> list[tuple[str, bytes | None]]:
    """Two floors whose layers share stems in sibling folders, a Facility table with a numeric ``color``
    and no color2, and the sidecars the real station folder carries, plus a directory entry."""
    space0 = make_dbf(SPACE_FIELDS, SPACE_0)
    space1 = make_dbf(SPACE_FIELDS, SPACE_1)
    facility = make_dbf([("name", "C", 10, 0), ("color", "N", 4, 0)], [[b"gate", b"   0"]])
    members: list[tuple[str, bytes | None]] = [("東京/", None)]
    for floor, space in (("0", space0), ("1", space1)):
        stem = f"東京/{floor}/Space"
        members += [
            (f"{stem}.shp", b"\x00\x00\x27\x0a PolygonZM floor " + floor.encode()),
            (f"{stem}.shx", b"shx " + floor.encode()),
            (f"{stem}.dbf", space),
            (f"{stem}.prj", b'PROJCS["JGD2011 / Japan Plane Rectangular CS IX"]'),
            (f"{stem}.cpg", b"UTF-8"),
            (f"{stem}.idx", b"ASIG index " + floor.encode()),
            (f"{stem}.shp.xml", "<metadata>東京</metadata>".encode()),
        ]
    members += [
        ("東京/0/Facility_Merge.shp", b"points"),
        ("東京/0/Facility_Merge.dbf", facility),
        ("東京/0/Facility_Merge.cpg", b"UTF-8"),
        ("東京/0/Facility_Merge.sbn", b"sbn"),
        ("東京/0/Facility_Merge.sbx", b"sbx"),
        ("東京/0/Facility_Merge.qix", b"qix"),
        ("東京/station.qmd", b"<qgis/>"),
        ("東京/acad.err", b"acad error log"),
    ]
    return members


DEMO_FLOOR_1 = [
    *[("白", "B021")] * 40,
    *[("薄鼠", "B022")] * 30,
    *[("薄空", "B001")] * 20,
    *[("濃空", "B001")] * 12,
    *[("トイレ", "B008")] * 6,
    *[("ラチ外白", "B999")] * 5,
    *[("黄", "B999")] * 4,
    *[("道白", "B029")] * 2,
    *[("薄紅", "B028")] * 2,
    *[("橙", "B999")] * 2,
    ("緑", "B999"),
    ("濃紅", "B028"),
    ("濃鼠", "B999"),
    ("濃鼠", "B010"),
    *[("赤", "B019")] * 3,
    *[("", "B019")] * 2,
]
DEMO_FLOOR_B1 = [*[("白", "B021")] * 3, *[("黄", "B999")] * 2]


def demo_station() -> bytes:
    """A zipped station for capture.mjs to screenshot: every rule but the GDB-only 進入制限あり, three
    unmapped rows, and a B1 layer whose color2 is too narrow (C(24)) for 階段・エスカレーター in UTF-8."""
    narrow = [(name, kind, 24 if name == "color2" else width, dec) for name, kind, width, dec in SPACE_FIELDS]
    members: list[tuple[str, bytes | None]] = []
    for floor, fields, rows in (("1", SPACE_FIELDS, DEMO_FLOOR_1), ("B1", narrow, DEMO_FLOOR_B1)):
        stem = f"DemoSta_6677.shp/DemoSta_{floor}_Space"
        members += [
            (f"{stem}.shp", b"shp " + floor.encode()),
            (f"{stem}.shx", b"shx " + floor.encode()),
            (f"{stem}.dbf", make_dbf(fields, [space_row(value, category) for value, category in rows])),
            (f"{stem}.prj", b'PROJCS["JGD2011 / Japan Plane Rectangular CS IX"]'),
            (f"{stem}.cpg", b"UTF-8"),
        ]
    members += [
        ("DemoSta_6677.shp/DemoSta_1_Facility_Merge.dbf", make_dbf([("name", "C", 10, 0)], [[b"gate"]])),
        ("DemoSta_6677.shp/DemoSta_1_Facility_Merge.sbn", b"sbn"),
        ("DemoSta_6677.shp/acad.err", b"acad error log"),
    ]
    return make_zip(members)


def zip_members(payload: bytes) -> list[tuple[str, tuple[int, ...], int, int, bytes]]:
    """Each member of a zip that passes its own CRC check, in order: name, date, compression, CRC, inflated data."""
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        assert archive.testzip() is None
        return [
            (info.filename, info.date_time, info.compress_type, info.CRC, archive.read(info)) for info in archive.infolist()
        ]


LAYER_FILE = Path(__file__).resolve().parent / "fixtures" / "color_theme" / "DemoSta_0_Space.lyrx"
"""One layer of the Tokyo station project as a layer file: its 14 color2 classes, with names and paths replaced."""


def layer_definition(name: str) -> dict[str, Any]:
    """The Tokyo layer, renamed: a ``CIMFeatureLayer`` with a ``color2`` unique-value renderer."""
    layer = copy.deepcopy(json.loads(LAYER_FILE.read_text(encoding="utf-8-sig"))["layerDefinitions"][0])
    layer["name"] = name
    layer["uRI"] = f"CIMPATH=map/{name.lower()}.json"
    return layer


def project_members() -> list[tuple[str, bytes, int]]:
    """An ``.aprx``'s members as (name, bytes, compression), one layer per member, as Pro 3.6 saves them.

    ``DemoSta_1_Space`` has a class of a value the theme does not know,
    ``DemoSta_1_Facility`` colours by ``category`` and ``DemoSta_B1_Space``
    by an Arcade expression on ``color2``; only the two Space layers before
    it can be rewritten.
    """
    space_1 = layer_definition("DemoSta_1_Space")
    red = copy.deepcopy(space_1["renderer"]["groups"][0]["classes"][0])
    red["label"] = "赤"
    red["values"] = [{"type": "CIMUniqueValue", "fieldValues": ["赤"]}]
    space_1["renderer"]["groups"][0]["classes"].append(red)
    facility = layer_definition("DemoSta_1_Facility")
    facility["renderer"]["fields"] = ["category"]
    arcade = layer_definition("DemoSta_B1_Space")
    arcade["renderer"]["fields"] = []
    arcade["renderer"]["valueExpressionInfo"] = {
        "type": "CIMExpressionInfo",
        "title": "Area",
        "expression": "Upper($feature.color2)",
        "returnType": "Default",
    }
    layers = [layer_definition("DemoSta_0_Space"), space_1, facility, arcade]
    the_map = {"type": "CIMMap", "name": "DemoSta", "layers": [layer["uRI"] for layer in layers]}
    index = {"type": "CIMIndex", "nodes": [layer["uRI"].removeprefix("CIMPATH=") for layer in layers]}
    info = b"<CIMDocumentInfo><Version>3.6.0</Version><Build>59530</Build></CIMDocumentInfo>"
    return [
        ("DocumentInfo.xml", info, zipfile.ZIP_DEFLATED),
        ("Index.json", _compact(index), zipfile.ZIP_DEFLATED),
        ("map/map.json", _compact(the_map), zipfile.ZIP_DEFLATED),
        *[(layer["uRI"].removeprefix("CIMPATH="), _compact(layer), zipfile.ZIP_DEFLATED) for layer in layers],
        ("Thumbnail/thumbnail.png", b"\x89PNG\r\n\x1a\n" + bytes(range(256)), zipfile.ZIP_STORED),
    ]


# One Shinjuku unit layer's classes, in its order: category, fill, outline. Every outline is 0.3 pt.
UNIT_CLASSES = [
    ("ATM", "#E5F8FF", "#B0C4CC"),
    ("accessible restroom", "#E5E6E6", "#828282"),
    ("auditorium", "#E5E6E6", "#C8C9CA"),
    ("clinic", "#E5F8FF", "#B0C4CC"),
    ("elevator", "#E5E6E6", "#C8C9CA"),
    ("escalator", "#FFFFFF", "#C8C9CA"),
    ("information desk", "#E5E6E6", "#C8C9CA"),
    ("mothersroom", "#E5E6E6", "#828282"),
    ("nonpublic", "#E5E6E6", "#C8C9CA"),
    ("opentobelow", "#FFFFFF", "#C8C9CA"),
    ("pharmacy", "#E5F8FF", "#B0C4CC"),
    ("platform", "#FFECE6", "#F2CDC2"),
    ("ramp", "#FFFFFF", "#C8C9CA"),
    ("ramp_sta", "#FCFCE3", "#999999"),
    ("restroom.female", "#E5E6E6", "#828282"),
    ("restroom.male", "#E5E6E6", "#828282"),
    ("restroom.wheelchair", "#E5E6E6", "#828282"),
    ("road", "#C8C9CA", "#C8C9CA"),
    ("smokingarea", "#E5E6E6", "#C8C9CA"),
    ("stairs", "#FFFFFF", "#C8C9CA"),
    ("store", "#E5F8FF", "#B0C4CC"),
    ("store_sta", "#C2E5F2", "#8FBACC"),
    ("theater", "#E5F8FF", "#B0C4CC"),
    ("ticket office", "#E5F8FF", "#B0C4CC"),
    ("unenclosedarea", "#E5E6E6", "#C8C9CA"),
    ("unspecified", "#E5E6E6", "#C8C9CA"),
    ("vegetation", "#96CB91", "#C8C9CA"),
    ("waitingroom", "#E5E6E6", "#C8C9CA"),
    ("walkway", "#FFFFFF", "#C8C9CA"),
    ("walkway_sta", "#FCFCE3", "#999999"),
]
FIXTURE_CLASSES = [("checkin.kiosk", "#E54A1A", "#686868"), ("equipment", "#E54A1A", "#686868")]


def _rgb(hex_colour: str) -> dict[str, Any]:
    return {"type": "CIMRGBColor", "values": [*(int(hex_colour[index : index + 2], 16) for index in (1, 3, 5)), 100]}


def category_class(category: str, fill: str, outline: str) -> dict[str, Any]:
    """A class as Pro saves it in a Shinjuku unit layer: one category, a 0.3 pt outline over a solid fill."""
    return {
        "type": "CIMUniqueValueClass",
        "label": category,
        "patch": "Default",
        "symbol": {
            "type": "CIMSymbolReference",
            "symbol": {
                "type": "CIMPolygonSymbol",
                "symbolLayers": [
                    {
                        "type": "CIMSolidStroke",
                        "enable": True,
                        "capStyle": "Round",
                        "joinStyle": "Round",
                        "lineStyle3D": "Strip",
                        "miterLimit": 10,
                        "width": 0.3,
                        "color": _rgb(outline),
                    },
                    {"type": "CIMSolidFill", "enable": True, "color": _rgb(fill)},
                ],
                "angleAlignment": "Map",
            },
        },
        "values": [{"type": "CIMUniqueValue", "fieldValues": [category]}],
        "visible": True,
    }


def category_layer_definition(name: str, classes: Sequence[tuple[str, str, str]] = UNIT_CLASSES) -> dict[str, Any]:
    """A layer coloured by ``category`` alone, the way the Revit/IMDF stations (Shinjuku) are; it has no ``color2``."""
    layer = layer_definition(name)
    layer["renderer"]["fields"] = ["category"]
    layer["renderer"]["groups"] = [
        {"type": "CIMUniqueValueGroup", "heading": "category", "classes": [category_class(*item) for item in classes]}
    ]
    return layer


def unit_project_members() -> list[tuple[str, bytes, int]]:
    """An ``.aprx`` shaped like Shinjuku's: two unit layers of 30 classes and a fixture layer the theme does not know."""
    layers = [
        category_layer_definition("DemoSta_1_unit"),
        category_layer_definition("DemoSta_B1_unit"),
        category_layer_definition("DemoSta_1_fixture", FIXTURE_CLASSES),
    ]
    the_map = {"type": "CIMMap", "name": "DemoSta", "layers": [layer["uRI"] for layer in layers]}
    return [
        ("map/map.json", _compact(the_map), zipfile.ZIP_DEFLATED),
        *[(layer["uRI"].removeprefix("CIMPATH="), _compact(layer), zipfile.ZIP_DEFLATED) for layer in layers],
    ]


def _compact(doc: Any) -> bytes:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def make_project(members: Sequence[tuple[str, bytes, int]]) -> bytes:
    """Pro dates every member 1980-00-00, a DOS date of zero."""
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data, compression in members:
            info = zipfile.ZipInfo(name, date_time=(1980, 0, 0, 0, 0, 0))
            info.compress_type = compression
            archive.writestr(info, data)
    return buffer.getvalue()


def demo_layer_files() -> bytes:
    """A zip of a layer file and two projects for capture.mjs: rewritten layers, a kept value, an Arcade renderer,
    and a project whose unit layers are coloured by category."""
    return make_zip(
        [
            ("DemoSta_layers/DemoSta_0_Space.lyrx", LAYER_FILE.read_bytes()),
            ("DemoSta_layers/DemoSta.aprx", make_project(project_members())),
            ("DemoSta_layers/DemoSta_units.aprx", make_project(unit_project_members())),
        ]
    )


def demo_category_station() -> bytes:
    """A zipped shapefile station with ``category`` and no ``color2``, for capture.mjs: nothing to rewrite, and why."""
    fields: list[Field] = [("name", "C", 20, 0), ("category", "C", 20, 0)]
    rows = [[b"room", category.encode("ascii")] for category in ("walkway", "store", "stairs")]
    members: list[tuple[str, bytes | None]] = []
    for floor in ("1", "B1"):
        stem = f"DemoUnits_6677.shp/DemoUnits_{floor}_unit"
        members += [
            (f"{stem}.shp", b"shp " + floor.encode()),
            (f"{stem}.shx", b"shx " + floor.encode()),
            (f"{stem}.dbf", make_dbf(fields, rows)),
            (f"{stem}.cpg", b"UTF-8"),
        ]
    return make_zip(members)
