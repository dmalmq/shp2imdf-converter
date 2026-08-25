"""Spec conformance of the ODC category code tables (別表8.2.4 / 別表8.5.1).

The tables are the export's only source of truth for `category`, and a wrong
entry is invisible in the output — every row still carries a plausible code. The
reference is 国土地理院「【別表】3次元地図データのカテゴリー一覧」
(https://www.gsi.go.jp/common/000212584.pdf).
"""

from __future__ import annotations

from typing import Any

import pytest

from backend.src.shapefile_exporter import _code_for_feature_category, _load_category_codes


def _unit(category: str) -> dict[str, Any]:
    return {"id": "11111111-1111-4111-8111-111111111111", "properties": {"category": category}}


def _report() -> dict[str, Any]:
    return {"category_code_fallbacks": [], "category_code_ambiguities": [], "category_code_aliases": {}}


def _space_code(category: str, report: dict[str, Any] | None = None) -> str:
    return _code_for_feature_category(
        _unit(category),
        prefix="B",
        source_candidates=["category", "imdf_cat"],
        table=_load_category_codes("b-codes.json"),
        fallback="B019",
        report=report if report is not None else _report(),
    )


@pytest.mark.phase5
@pytest.mark.parametrize(
    ("category", "code"),
    [
        # 通路/コンコース is B029. B024 is 動く歩道 and B025 is スロープ, so a
        # plain walkway exported as B024 claims a moving walkway that isn't there.
        ("walkway", "B029"),
        ("movingwalkway", "B024"),
        ("ramp", "B025"),
        ("platform", "B028"),
        ("nonpublic", "B026"),
        ("stairs", "B021"),
        ("elevator", "B022"),
        ("escalator", "B023"),
        ("retail", "B001"),
        ("tickets", "B005"),
        ("information", "B006"),
        ("restroom.male", "B007"),
        ("restroom.female", "B008"),
        ("restroom.unisex", "B009"),
        ("restroom", "B010"),
        ("room", "B019"),
        ("opentobelow", "B020"),
        ("mothersroom", "B016"),
        ("smokingarea", "B015"),
    ],
)
def test_space_categories_use_the_spec_code(category: str, code: str) -> None:
    assert _space_code(category) == code


@pytest.mark.phase5
def test_source_vocabulary_aliases_onto_the_spec_category() -> None:
    # JR's opendata uses its own wording; none of these are IMDF categories.
    assert _space_code("store_sta") == "B001"
    assert _space_code("store") == "B001"
    assert _space_code("ticket office") == "B005"
    assert _space_code("information desk") == "B006"
    assert _space_code("walkway_sta") == "B029"
    assert _space_code("accessible restroom") == "B011"
    # A planted area is その他部屋の範囲, not a C009 planter fixture.
    assert _space_code("vegetation") == "B019"

    report = _report()
    _space_code("store_sta", report)
    assert report["category_code_aliases"] == {"store_sta -> retail (B001)": 1}
    assert report["category_code_fallbacks"] == []


@pytest.mark.phase5
def test_multipurpose_lavatory_resolves_to_the_declared_code() -> None:
    # B011-B014 are all 多機能トイレ, distinguished by オストメイト / おむつ交換
    # support that the source does not state. The base code is declared, so this
    # is a decision on record rather than an alphabetical accident.
    report = _report()
    assert _space_code("restroom.wheelchair", report) == "B011"
    assert report["category_code_ambiguities"] == []


@pytest.mark.phase5
def test_unclassifiable_space_falls_back_to_other_room() -> None:
    # B999 is 屋外 (the ground surface outside the building), so it must never be
    # the catch-all: an unclassifiable space is B019 その他部屋の範囲.
    report = _report()
    assert _space_code("something the spec never heard of", report) == "B019"
    assert report["category_code_fallbacks"] == [
        {
            "feature_id": "11111111-1111-4111-8111-111111111111",
            "category": "something the spec never heard of",
            "fallback": "B019",
            "reason": "missing_mapping",
        }
    ]
    assert _load_category_codes("b-codes.json").codes_by_category["unenclosedarea"] == ["B999"]


@pytest.mark.phase5
def test_a_code_set_on_the_property_passes_through() -> None:
    # The review screen writes spec codes onto `category` directly, with no
    # source metadata behind them.
    from backend.src.shapefile_exporter import _load_category_codes as load

    report = _report()
    assert (
        _code_for_feature_category(
            {"id": "venue-1", "properties": {"category": "A001"}},
            prefix="A",
            source_candidates=["category"],
            table=load("a-codes.json"),
            fallback="A999",
            report=report,
        )
        == "A001"
    )
    assert report["category_code_fallbacks"] == []


@pytest.mark.phase5
def test_source_codes_pass_through_untranslated() -> None:
    # A source row that already carries a spec code keeps it, including the
    # 多機能トイレ variants the aliases cannot infer.
    feature = {"id": "x", "properties": {"category": "B013", "metadata": {"category": "B013"}}}
    assert (
        _code_for_feature_category(
            feature,
            prefix="B",
            source_candidates=["category"],
            table=_load_category_codes("b-codes.json"),
            fallback="B019",
            report=_report(),
        )
        == "B013"
    )


@pytest.mark.phase5
@pytest.mark.parametrize(
    ("category", "code"),
    [
        ("column", "C001"),
        ("vegetation", "C009"),
        ("locker", "C012"),
        ("vendingmachine", "C013"),
        ("platform.screen", "C101"),
        # 別表8.5.1: C102 is 自動券売機 and C103 is the platform-edge TWSI block.
        ("ticket.vending", "C102"),
        ("twsi.platform", "C103"),
        ("ticketgate", "C104"),
        ("checkin.kiosk", "C202"),
        # ホームドア and 可動式ホーム柵 share C101.
        ("platform.gate", "C101"),
    ],
)
def test_fixture_categories_use_the_spec_code(category: str, code: str) -> None:
    assert (
        _code_for_feature_category(
            {"id": "y", "properties": {"category": category}},
            prefix="C",
            source_candidates=["category"],
            table=_load_category_codes("c-codes.json"),
            fallback="C999",
            report=_report(),
        )
        == code
    )
