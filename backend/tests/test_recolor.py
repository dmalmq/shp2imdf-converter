"""Recolouring an uploaded station: only color2 bytes change, every file comes back, a second run is a no-op."""

from __future__ import annotations

from pathlib import Path
import zipfile

import pytest

from backend.src.color_theme import ColorTheme, load_color_theme
from backend.src.dbf_table import DbfTable
from backend.src.recolor import EXPANDED_LIMIT_MESSAGE, convert, inspect
from backend.tests.color_theme_fixtures import (
    SPACE_FIELDS,
    make_dbf,
    make_zip,
    read_zip,
    space_row,
    station_members,
)

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 64 * 1024 * 1024


@pytest.fixture(scope="module")
def theme() -> ColorTheme:
    return load_color_theme(CONFIG)


def _convert_one(theme: ColorTheme, dbf: bytes, *, cpg: bytes | None = b"UTF-8") -> bytes:
    blobs = [("st/a_Space.dbf", dbf)] + ([("st/a_Space.cpg", cpg)] if cpg is not None else [])
    return read_zip(convert(theme, blobs, max_bytes=LIMIT).data)["st/a_Space.dbf"]


def _cells(dbf: bytes, field: str, codec: str = "utf-8") -> list[str]:
    table = DbfTable.parse(dbf)
    column = table.field(field)
    return [table.text(row, column).decode(codec) for row in range(table.record_count)]


def _span(table: DbfTable, row: int, field: str) -> range:
    column = table.field(field)
    start = table.header_length + row * table.record_length + column.offset
    return range(start, start + column.width)


def test_only_the_color2_cells_of_rewritten_rows_change(theme: ColorTheme) -> None:
    rows = [
        space_row("白", "B021"),
        space_row("濃鼠", "B008"),
        space_row("濃鼠", "B999"),
        space_row("施設", "B001"),
        space_row("赤", "B001"),
        space_row("", "B019"),
        space_row("白", "B021"),
        space_row("黄", "B999", color="濃鼠"),
    ]
    rows[5][2] = b""
    source = make_dbf(SPACE_FIELDS, rows, deleted=frozenset({6}))

    output = _convert_one(theme, source)

    table = DbfTable.parse(source)
    rewritten = {0, 1, 2, 7}
    allowed = {index for row in rewritten for index in _span(table, row, "color2")}
    changed = {index for index, (a, b) in enumerate(zip(source, output)) if a != b}
    assert len(output) == len(source)
    assert changed and changed <= allowed
    assert output[: table.header_length] == source[: table.header_length]
    assert _cells(output, "color2") == [
        "階段・エスカレーター",
        "施設",
        "改札外通路",
        "施設",
        "赤",
        "",
        "白",
        "在来線改札内",
    ]
    assert _cells(output, "color") == _cells(source, "color")


def test_a_nul_padded_cell_is_rewritten_inside_its_own_span(theme: ColorTheme) -> None:
    source = make_dbf(SPACE_FIELDS, [space_row("薄鼠", "B022"), space_row("黄", "B999")], pad=b"\x00")

    output = _convert_one(theme, source)

    table = DbfTable.parse(source)
    changed = {index for index, (a, b) in enumerate(zip(source, output)) if a != b}
    assert changed <= set(_span(table, 0, "color2")) | set(_span(table, 1, "color2"))
    assert _cells(output, "color2") == ["進入制限エリア", "在来線改札内"]
    assert _cells(output, "name") == ["room", "room"]


ROWS = [("白", "B021"), ("濃鼠", "B008"), ("薄空", "B001"), ("トイレ", "B007"), ("赤", "B019")]


@pytest.mark.parametrize(
    ("codec", "cpg", "language_driver", "source"),
    [
        ("utf-8", b"UTF-8", 0, "cpg"),
        ("cp932", b"932", 0, "cpg"),
        ("cp932", b"ANSI 932", 0, "cpg"),
        ("cp932", None, 0x13, "ldid"),
        ("cp932", None, 0, "sniffed"),
        ("utf-8", None, 0, "sniffed"),
    ],
)
def test_every_encoding_route_rewrites_in_the_tables_own_encoding(
    theme: ColorTheme, codec: str, cpg: bytes | None, language_driver: int, source: str
) -> None:
    dbf = make_dbf(SPACE_FIELDS, [space_row(v, c, codec) for v, c in ROWS], language_driver=language_driver)
    blobs = [("a_Space.dbf", dbf)] + ([("a_Space.cpg", cpg)] if cpg else [])

    report = inspect(theme, blobs, max_bytes=LIMIT).theme
    output = read_zip(convert(theme, blobs, max_bytes=LIMIT).data)["a_Space.dbf"]

    assert [(layer.encoding.codec, layer.encoding.source) for layer in report.layers] == [(codec, source)]
    assert report.totals.recolor == 4
    assert [line.value for line in report.unmapped] == ["赤"]
    assert _cells(output, "color2", codec) == ["階段・エスカレーター", "施設", "施設", "施設", "赤"]


def test_a_table_behind_the_wrong_cpg_is_reported_and_left_alone(theme: ColorTheme) -> None:
    source = make_dbf(SPACE_FIELDS, [space_row(v, c, "cp932") for v, c in ROWS])

    report = inspect(theme, [("a_Space.dbf", source), ("a_Space.cpg", b"UTF-8")], max_bytes=LIMIT).theme
    output = _convert_one(theme, source)

    assert report.totals.recolor == 0
    assert report.totals.undecodable == len(ROWS)
    assert output == source


def test_a_row_whose_category_does_not_decode_is_reported_and_left_alone(theme: ColorTheme) -> None:
    unreadable_restroom = space_row("濃鼠", "B008")
    unreadable_restroom[1] = b"B0\xff8"
    source = make_dbf(SPACE_FIELDS, [unreadable_restroom, space_row("白", "B021")])

    report = inspect(theme, [("st/a_Space.dbf", source), ("st/a_Space.cpg", b"UTF-8")], max_bytes=LIMIT).theme
    output = _convert_one(theme, source)

    assert (report.totals.recolor, report.totals.undecodable) == (1, 1)
    assert _cells(output, "color2") == ["濃鼠", "階段・エスカレーター"]


def test_a_value_wider_than_color2_is_reported_and_its_cell_kept(theme: ColorTheme) -> None:
    fields = [(name, kind, 24 if name == "color2" else width, dec) for name, kind, width, dec in SPACE_FIELDS]
    source = make_dbf(fields, [space_row("白", "B021"), space_row("黄", "B999")])

    report = inspect(theme, [("st/a_Space.dbf", source), ("st/a_Space.cpg", b"UTF-8")], max_bytes=LIMIT).theme
    output = _convert_one(theme, source)

    stairs = next(line for line in report.rules if line.old == "白")
    assert (stairs.rows, stairs.too_wide) == (0, 1)
    assert report.totals.too_wide == 1
    assert _cells(output, "color2") == ["白", "在来線改札内"]


def test_a_numeric_color2_and_a_broken_header_pass_through(theme: ColorTheme) -> None:
    numeric = make_dbf([("color2", "N", 4, 0), ("category", "C", 4, 0)], [[b"   1", b"B021"]])
    broken = bytearray(make_dbf(SPACE_FIELDS, [space_row("白", "B021")]))
    broken[10:12] = (int.from_bytes(broken[10:12], "little") + 1).to_bytes(2, "little")
    blobs = [("st/n_Space.dbf", numeric), ("st/b_Space.dbf", bytes(broken))]

    report = inspect(theme, blobs, max_bytes=LIMIT).theme
    output = read_zip(convert(theme, blobs, max_bytes=LIMIT).data)

    assert [(line.id, line.reason) for line in report.skipped] == [
        ("st/n_Space.dbf", "field_not_text"),
        ("st/b_Space.dbf", "unreadable"),
    ]
    assert output == dict(blobs)


def test_a_text_field_with_a_decimal_count_is_read_at_its_own_width(theme: ColorTheme) -> None:
    source = make_dbf([("color2", "C", 30, 1), ("category", "C", 4, 0)], [["白".encode(), b"B021"]])

    report = inspect(theme, [("st/a_Space.dbf", source), ("st/a_Space.cpg", b"UTF-8")], max_bytes=LIMIT).theme
    output = _convert_one(theme, source)

    assert report.skipped == ()
    assert [(layer.width, layer.counts.recolor) for layer in report.layers] == [(30, 1)]
    assert _cells(output, "color2") == ["階段・エスカレーター"]
    assert _cells(output, "category") == ["B021"]


def test_the_write_primitive_never_truncates_or_touches_deleted_rows() -> None:
    table = DbfTable.parse(make_dbf(SPACE_FIELDS, [space_row("白", "B021"), space_row("白", "B021")], deleted=frozenset({1})))
    color2 = table.field("color2")

    with pytest.raises(ValueError):
        table.with_text(color2, {0: b"x" * 255})
    with pytest.raises(ValueError):
        table.with_text(color2, {1: b"x"})
    with pytest.raises(ValueError):
        table.with_text(table.field("floor"), {0: b"1"})


@pytest.mark.parametrize("cp932_names", [False, True])
def test_a_zipped_station_comes_back_with_every_entry_in_order(theme: ColorTheme, cp932_names: bool) -> None:
    members = station_members()
    archive = convert(theme, [("東京.zip", make_zip(members, cp932_names=cp932_names))], max_bytes=LIMIT)

    output = read_zip(archive.data)

    assert archive.filename == "東京_new-colors.zip"
    assert list(output) == [name for name, _ in members]
    changed = {name for name, data in members if output[name] != data}
    assert changed == {"東京/0/Space.dbf", "東京/1/Space.dbf"}
    assert _cells(output["東京/1/Space.dbf"], "color2") == ["在来線改札内", "施設", "施設", "進入制限エリア", "新幹線改札内"]
    assert _cells(output["東京/0/Space.dbf"], "color2") == ["改札外通路", "改札外通路", "改札外通路", "階段・エスカレーター"]


def test_a_dropped_folder_keeps_its_layout_and_names_the_download() -> None:
    theme = load_color_theme(CONFIG)
    members = [(name.replace("東京/", "/JRTokyoSta_6677.shp/", 1), data) for name, data in station_members() if data is not None]

    inspection = inspect(theme, members, max_bytes=LIMIT)
    archive = convert(theme, members, max_bytes=LIMIT)

    assert inspection.dataset.name == "JRTokyoSta_6677"
    assert inspection.dataset.download_name == "JRTokyoSta_6677_new-colors.zip"
    assert inspection.dataset.files == len(members)
    assert archive.filename == "JRTokyoSta_6677_new-colors.zip"
    assert list(read_zip(archive.data)) == [name.lstrip("/") for name, _ in members]


def test_a_second_run_changes_nothing(theme: ColorTheme) -> None:
    folder = [(f"./{name}", data) for name, data in station_members() if data is not None]
    for upload in (folder, [("東京.zip", make_zip(station_members()))]):
        first = convert(theme, upload, max_bytes=LIMIT)
        second = convert(theme, [(first.filename, first.data)], max_bytes=LIMIT)
        rerun = inspect(theme, [(first.filename, first.data)], max_bytes=LIMIT).theme

        assert second.data == first.data
        assert second.filename == first.filename == "東京_new-colors.zip"
        assert rerun.totals.recolor == 0
        assert rerun.totals.already_new == inspect(theme, upload, max_bytes=LIMIT).theme.totals.recolor


@pytest.mark.parametrize("bad", ["../x.dbf", "a/../../x.dbf", "C:/x.dbf", "//host/share/x.dbf", "a\\..\\..\\x.dbf"])
def test_a_path_that_could_escape_is_refused(theme: ColorTheme, bad: str) -> None:
    with pytest.raises(ValueError, match="Unsafe path"):
        inspect(theme, [(bad, b"x"), ("ok.dbf", b"y")], max_bytes=LIMIT)
    with pytest.raises(ValueError, match="Unsafe path"):
        inspect(theme, [("bad.zip", make_zip([(bad.replace("\\", "/"), b"x")]))], max_bytes=LIMIT)


def test_two_paths_differing_only_by_case_are_refused(theme: ColorTheme) -> None:
    with pytest.raises(ValueError, match="share a path"):
        inspect(theme, [("st/A.dbf", b"x"), ("st/a.DBF", b"y")], max_bytes=LIMIT)


def test_a_zip_declaring_more_than_the_limit_is_refused_before_inflating(theme: ColorTheme, monkeypatch) -> None:
    payload = make_zip([("big.bin", b"\x00" * 4096)])

    def refuse(*_args, **_kwargs):
        raise AssertionError("inflated a member of an oversized zip")

    monkeypatch.setattr(zipfile.ZipFile, "read", refuse)
    with pytest.raises(ValueError) as caught:
        inspect(theme, [("big.zip", payload)], max_bytes=1024)
    assert str(caught.value) == EXPANDED_LIMIT_MESSAGE
