"""Style files beside a station's shapefiles: which layers get them, what they class, and what they must not touch.

The tables are typed out from the Figma New table and the operator's category
table, not read from the config, so a wrong class or colour in either fails.
Whether QGIS and Esri accept the files is ``test_style_files_qgis.py`` and
``test_cim_esri_parser.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import pytest

from backend.src.cim_symbology import retheme_document
from backend.src.color_theme import ColorTheme, load_color_theme
from backend.src.recolor import convert, inspect
from backend.tests.color_theme_fixtures import (
    POINT,
    POLYGON_M,
    POLYGON_Z,
    POLYLINE,
    SPACE_FIELDS,
    Field,
    make_dbf,
    make_zip,
    read_zip,
    shp_header,
    space_row,
    square_shapefile,
)

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 64 * 1024 * 1024
OUTLINE = "#657678"
OTHER = ("その他 (Other)", "#D9D9D9")

COLOUR_CLASSES = [
    ("改札外通路", "#FFFFFF", ["改札外通路", "ラチ外白", "濃鼠", "道白"]),
    ("在来線改札内", "#F2F7FB", ["在来線改札内", "黄", "薄紅"]),
    ("新幹線改札内", "#E5EFF7", ["新幹線改札内", "橙", "緑", "濃紅"]),
    ("施設", "#DDEBEC", ["施設", "薄空", "濃空", "トイレ"]),
    ("進入制限エリア", "#F2F2F2", ["進入制限エリア", "薄鼠", "進入制限あり"]),
    ("階段・エスカレーター", "#FFFFFF", ["階段・エスカレーター", "白"]),
]
CATEGORY_CLASSES = [
    ("改札外通路", "#FFFFFF", ["walkway", "ramp", "road"]),
    ("在来線改札内", "#F2F7FB", ["walkway_sta", "ramp_sta", "platform"]),
    (
        "施設",
        "#DDEBEC",
        [
            "store",
            "store_sta",
            "ATM",
            "clinic",
            "pharmacy",
            "theater",
            "ticket office",
            "restroom.female",
            "restroom.male",
            "restroom.wheelchair",
            "accessible restroom",
        ],
    ),
    (
        "進入制限エリア",
        "#F2F2F2",
        [
            "elevator",
            "auditorium",
            "information desk",
            "mothersroom",
            "nonpublic",
            "smokingarea",
            "unenclosedarea",
            "unspecified",
            "waitingroom",
        ],
    ),
    ("階段・エスカレーター", "#FFFFFF", ["stairs", "escalator", "opentobelow"]),
]
SIX_AREAS = ["free_area", "paid_area", "paid_area_shinkansen", "facilities", "restricted", "stairs_escalators"]
FIVE_AREAS = [key for key in SIX_AREAS if key != "paid_area_shinkansen"]

UNIT_FIELDS: list[Field] = [("name", "C", 20, 0), ("category", "C", 20, 0)]


@pytest.fixture(scope="module")
def theme() -> ColorTheme:
    return load_color_theme(CONFIG)


def unit_dbf(*categories: str) -> bytes:
    return make_dbf(UNIT_FIELDS, [[b"room", category.encode("utf-8")] for category in categories])


def layer(stem: str, dbf: bytes, shp: bytes | None = None, *, sidecars: bool = True) -> list[tuple[str, bytes]]:
    """A layer's files in the order a station folder lists them; a real polygon .shp unless one is given."""
    real_shp, shx = square_shapefile(1)
    files = [(f"{stem}.shp", real_shp if shp is None else shp), (f"{stem}.shx", shx), (f"{stem}.dbf", dbf)]
    if sidecars:
        files += [(f"{stem}.prj", b'PROJCS["JGD2011"]'), (f"{stem}.cpg", b"UTF-8"), (f"{stem}.shp.xml", b"<metadata/>")]
    return files


def station() -> list[tuple[str, bytes]]:
    """A color2 layer, a category layer, and four layers that must get no style, with a loose file between them."""
    return [
        *layer("st/1_Space", make_dbf(SPACE_FIELDS, [space_row("黄", "B999"), space_row("赤", "B001")])),
        ("st/acad.err", b"acad error log"),
        *layer("st/1_unit", unit_dbf("walkway", "vegetation")),
        *layer("st/1_opening", unit_dbf("walkway"), shp_header(POLYLINE)),
        *layer("st/1_amenity", unit_dbf("store"), shp_header(POINT)),
        *layer("st/1_fixture", unit_dbf("checkin.kiosk", "equipment")),
        *layer("st/1_level", make_dbf([("name", "C", 20, 0)], [[b"1F"]])),
    ]


def _hex(rgb: list[int] | list[str]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*(int(part) for part in rgb[:3]))


def read_qml(data: bytes) -> dict[str, Any]:
    """What a style says, read as XML: its field, then (label, fill, values) per category and each outline."""
    root = ElementTree.fromstring(data)
    renderer = root.find("renderer-v2")
    symbols = {}
    for symbol in renderer.find("symbols"):
        (fill_layer,) = symbol.findall("layer")
        options = {option.get("name"): option.get("value") for option in fill_layer.find("Option")}
        symbols[symbol.get("name")] = (fill_layer.get("class"), options)
    classes = []
    for category in renderer.find("categories"):
        _, options = symbols[category.get("symbol")]
        values = [val.get("value") for val in category.findall("val")] or [category.get("value")]
        classes.append((category.get("label"), _hex(options["color"].split(",")), values))
    return {
        "type": renderer.get("type"),
        "field": renderer.get("attr"),
        "classes": classes,
        "outlines": {
            (kind, _hex(options["outline_color"].split(",")), options["outline_width"], options["outline_width_unit"])
            for kind, options in symbols.values()
        },
    }


def _cim_colours(reference: dict[str, Any]) -> tuple[str, str, float]:
    stroke, fill = reference["symbol"]["symbolLayers"]
    assert (stroke["type"], fill["type"], reference["symbol"]["type"]) == ("CIMSolidStroke", "CIMSolidFill", "CIMPolygonSymbol")
    return _hex(fill["color"]["values"]), _hex(stroke["color"]["values"]), stroke["width"]


def read_lyrx(data: bytes) -> dict[str, Any]:
    """What a layer file says, read as JSON: its data connection, field, classes, default symbol and outlines."""
    (definition,) = json.loads(data.decode("utf-8"))["layerDefinitions"]
    renderer = definition["renderer"]
    (group,) = renderer["groups"]
    classes = []
    outlines = set()
    for item in group["classes"]:
        fill, stroke, width = _cim_colours(item["symbol"])
        classes.append((item["label"], fill, [value["fieldValues"][0] for value in item["values"]]))
        outlines.add((stroke, width))
    other_fill, stroke, width = _cim_colours(renderer["defaultSymbol"])
    outlines.add((stroke, width))
    return {
        "name": definition["name"],
        "connection": definition["featureTable"]["dataConnection"],
        "type": renderer["type"],
        "fields": renderer["fields"],
        "classes": classes,
        "other": (renderer["useDefaultSymbol"], renderer["defaultLabel"], other_fill),
        "outlines": outlines,
    }


def converted(theme: ColorTheme, upload: list[tuple[str, bytes]], *, style_files: bool = True) -> dict[str, bytes | None]:
    return read_zip(convert(theme, upload, max_bytes=LIMIT, style_files=style_files).data)


def test_a_color2_layer_is_classed_by_area_with_new_and_old_values_in_the_theme_fills(theme: ColorTheme) -> None:
    output = converted(theme, station())

    qml = read_qml(output["st/1_Space.qml"])
    assert (qml["type"], qml["field"]) == ("categorizedSymbol", "color2")
    assert qml["classes"] == [*COLOUR_CLASSES, (OTHER[0], OTHER[1], [""])]
    assert qml["outlines"] == {("SimpleFill", OUTLINE, "0.3", "Point")}

    lyrx = read_lyrx(output["st/1_Space.lyrx"])
    assert (lyrx["type"], lyrx["fields"]) == ("CIMUniqueValueRenderer", ["color2"])
    assert lyrx["classes"] == COLOUR_CLASSES
    assert lyrx["other"] == (True, *OTHER)
    assert lyrx["outlines"] == {(OUTLINE, 0.3)}


def test_a_category_layer_is_classed_by_the_category_table(theme: ColorTheme) -> None:
    output = converted(theme, station())

    qml = read_qml(output["st/1_unit.qml"])
    assert (qml["type"], qml["field"]) == ("categorizedSymbol", "category")
    assert qml["classes"] == [*CATEGORY_CLASSES, (OTHER[0], OTHER[1], [""])]
    assert qml["outlines"] == {("SimpleFill", OUTLINE, "0.3", "Point")}

    lyrx = read_lyrx(output["st/1_unit.lyrx"])
    assert lyrx["fields"] == ["category"]
    assert lyrx["classes"] == CATEGORY_CLASSES
    assert lyrx["other"] == (True, *OTHER)
    assert lyrx["outlines"] == {(OUTLINE, 0.3)}


def test_the_layer_file_points_at_the_shapefile_beside_it(theme: ColorTheme) -> None:
    lyrx = read_lyrx(converted(theme, station())["st/1_Space.lyrx"])

    assert lyrx["name"] == "1_Space"
    assert lyrx["connection"] == {
        "type": "CIMStandardDataConnection",
        "workspaceConnectionString": "DATABASE=.",
        "workspaceFactory": "Shapefile",
        "dataset": "1_Space.shp",
        "datasetType": "esriDTFeatureClass",
    }


def test_a_line_point_or_uncolourable_layer_gets_no_style_file(theme: ColorTheme) -> None:
    upload = station()

    output = converted(theme, upload)
    report = inspect(theme, upload, max_bytes=LIMIT).theme

    added = sorted(set(output) - {name for name, _ in upload})
    assert added == ["st/1_Space.lyrx", "st/1_Space.qml", "st/1_unit.lyrx", "st/1_unit.qml"]
    assert sorted(line.path for line in report.style_files) == added


@pytest.mark.parametrize("shape_type", [POLYGON_Z, POLYGON_M])
def test_a_polygon_layer_with_z_or_m_is_styled(theme: ColorTheme, shape_type: int) -> None:
    upload = layer("st/1_Space", make_dbf(SPACE_FIELDS, [space_row("黄", "B999")]), square_shapefile(1, shape_type)[0])

    assert {"st/1_Space.qml", "st/1_Space.lyrx"} <= set(converted(theme, upload))


@pytest.mark.parametrize(
    "shp",
    [b"", b"shp 1", shp_header(5)[:99], b"\x00" * 100, shp_header(0), shp_header(8), shp_header(31)],
    ids=["empty", "not a shapefile", "cut off header", "no file code", "null shapes", "multipoint", "multipatch"],
)
def test_a_shp_that_is_not_a_readable_polygon_header_gets_no_style_file(theme: ColorTheme, shp: bytes) -> None:
    upload = layer("st/1_Space", make_dbf(SPACE_FIELDS, [space_row("黄", "B999")]), shp)

    assert list(converted(theme, upload)) == [name for name, _ in upload]


def test_a_table_without_its_shp_or_inside_a_geodatabase_folder_gets_no_style_file(theme: ColorTheme) -> None:
    space = make_dbf(SPACE_FIELDS, [space_row("施設", "B001")])
    upload = [("st/lonely_Space.dbf", space), *layer("st/old.gdb/1_Space", space)]

    report = inspect(theme, upload, max_bytes=LIMIT, gdal_python=None).theme

    assert report.style_files == ()


def test_a_numeric_color2_is_not_a_field_to_class_by(theme: ColorTheme) -> None:
    numeric = make_dbf([("color2", "N", 4, 0), ("category", "C", 20, 0)], [[b"   1", b"walkway"]])

    output = converted(theme, layer("st/1_unit", numeric))

    assert read_qml(output["st/1_unit.qml"])["field"] == "category"


def test_the_report_lists_each_style_file_with_its_field_and_classes(theme: ColorTheme) -> None:
    report = inspect(theme, station(), max_bytes=LIMIT).theme

    assert [(line.path, line.kind, line.layer, line.field, list(line.classes), line.outcome) for line in report.style_files] == [
        ("st/1_Space.qml", "qml", "st/1_Space.shp", "color2", SIX_AREAS, "added"),
        ("st/1_Space.lyrx", "lyrx", "st/1_Space.shp", "color2", SIX_AREAS, "added"),
        ("st/1_unit.qml", "qml", "st/1_unit.shp", "category", FIVE_AREAS, "added"),
        ("st/1_unit.lyrx", "lyrx", "st/1_unit.shp", "category", FIVE_AREAS, "added"),
    ]


def test_an_existing_style_file_is_kept_and_reported_never_overwritten(theme: ColorTheme) -> None:
    mine = b"<qgis>the operator's own style</qgis>"
    upload = [*layer("st/1_Space", make_dbf(SPACE_FIELDS, [space_row("黄", "B999")])), ("st/1_SPACE.QML", mine)]

    output = converted(theme, upload)
    report = inspect(theme, upload, max_bytes=LIMIT).theme

    assert output["st/1_SPACE.QML"] == mine
    assert "st/1_Space.qml" not in output
    assert [(line.path, line.outcome) for line in report.style_files] == [
        ("st/1_SPACE.QML", "kept"),
        ("st/1_Space.lyrx", "added"),
    ]
    assert read_lyrx(output["st/1_Space.lyrx"])["fields"] == ["color2"]


@pytest.mark.parametrize("zipped", [False, True])
def test_without_the_option_the_download_has_no_style_files_and_the_default_is_off(theme: ColorTheme, zipped: bool) -> None:
    upload = [("st.zip", make_zip(station()))] if zipped else station()

    off = convert(theme, upload, max_bytes=LIMIT, style_files=False)
    default = convert(theme, upload, max_bytes=LIMIT)

    assert list(read_zip(off.data)) == [name for name, _ in station()]
    assert list(read_zip(default.data)) == list(read_zip(off.data))
    if zipped:
        # A folder upload is stamped with the time of the run; a zip keeps its members' dates.
        assert default.data == off.data


def test_every_uploaded_file_comes_back_as_it_does_without_style_files(theme: ColorTheme) -> None:
    upload = station()

    with_styles = converted(theme, upload)
    without = converted(theme, upload, style_files=False)

    assert {name: with_styles[name] for name in without} == without
    untouched = {name for name, data in upload if without[name] == data}
    assert {name for name, _ in upload} - untouched == {"st/1_Space.dbf"}


def test_style_files_follow_the_last_file_of_their_layer(theme: ColorTheme) -> None:
    names = list(converted(theme, station()))

    assert names[:9] == [
        "st/1_Space.shp",
        "st/1_Space.shx",
        "st/1_Space.dbf",
        "st/1_Space.prj",
        "st/1_Space.cpg",
        "st/1_Space.shp.xml",
        "st/1_Space.qml",
        "st/1_Space.lyrx",
        "st/acad.err",
    ]
    assert names[names.index("st/1_unit.shp.xml") + 1 :][:3] == ["st/1_unit.qml", "st/1_unit.lyrx", "st/1_opening.shp"]


def test_a_layer_whose_name_starts_another_layers_name_keeps_its_own_style_files(theme: ColorTheme) -> None:
    space = make_dbf(SPACE_FIELDS, [space_row("黄", "B999")])
    upload = [*layer("st/1_Space", space, sidecars=False), *layer("st/1_Space_Merge", space, sidecars=False)]

    assert list(converted(theme, upload)) == [
        "st/1_Space.shp",
        "st/1_Space.shx",
        "st/1_Space.dbf",
        "st/1_Space.qml",
        "st/1_Space.lyrx",
        "st/1_Space_Merge.shp",
        "st/1_Space_Merge.shx",
        "st/1_Space_Merge.dbf",
        "st/1_Space_Merge.qml",
        "st/1_Space_Merge.lyrx",
    ]


def test_a_second_run_adds_no_duplicate_style_files_and_changes_none(theme: ColorTheme) -> None:
    first = convert(theme, [("st.zip", make_zip(station()))], max_bytes=LIMIT, style_files=True)

    second = convert(theme, [(first.filename, first.data)], max_bytes=LIMIT, style_files=True)
    rerun = inspect(theme, [(first.filename, first.data)], max_bytes=LIMIT).theme

    assert second.data == first.data
    assert [line.outcome for line in rerun.style_files] == ["kept"] * 4
    assert [(file.path, [renderer.outcome for renderer in file.renderers]) for file in rerun.symbology] == [
        ("st/1_Space.lyrx", ["already_new"]),
        ("st/1_unit.lyrx", ["already_new"]),
    ]


@pytest.mark.parametrize("stem", ["st/1_Space", "st/1_unit"])
def test_retheming_a_generated_layer_file_finds_the_same_values_in_every_class(theme: ColorTheme, stem: str) -> None:
    generated = converted(theme, station())[f"{stem}.lyrx"]
    doc = json.loads(generated.decode("utf-8"))

    (change,) = retheme_document(doc, theme)

    assert (change.outcome, change.kept) == ("already_new", ())
    assert doc == json.loads(generated.decode("utf-8"))

