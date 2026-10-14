"""The layer tree a vector tile build chooses from, read from a project's CIM JSON, and the default choice."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.src.tile_layers import (
    NO_EXCLUSIONS,
    LayersUnreadable,
    MapLayers,
    NoMapLayers,
    ProjectMaps,
    SelectionError,
    TileExclusions,
    default_selection,
    load_tile_exclusions,
    read_project_layers,
    tile_plan,
    visibility_plan,
    walk,
)
from backend.tests.color_theme_fixtures import TILE_MAP, make_project, tile_map_uri, tile_project, tile_uri

pytestmark = [pytest.mark.colortheme, pytest.mark.vectortiles]

PATTERNS = Path(__file__).resolve().parents[1] / "config" / "vector_tile_exclusions.json"
LIMIT = 1 << 30


@pytest.fixture(scope="module")
def exclusions() -> TileExclusions:
    return load_tile_exclusions(PATTERNS)


def _maps(*maps: tuple[str, list]) -> ProjectMaps:
    project = read_project_layers(tile_project(maps=maps), NO_EXCLUSIONS, max_bytes=LIMIT)
    assert isinstance(project, ProjectMaps)
    return project


def _map(exclusions: TileExclusions = NO_EXCLUSIONS) -> MapLayers:
    project = read_project_layers(tile_project(), exclusions, max_bytes=LIMIT)
    assert isinstance(project, ProjectMaps)
    return project.chosen(None)


def _rows(layers: MapLayers) -> list[tuple[str, bool, bool, str | None, bool]]:
    return [
        (long_name, node.group, node.visible, node.excluded_by, node.tiled_by_default) for node, long_name in walk(layers.layers)
    ]


def test_the_tree_is_the_maps_groups_and_layers_in_drawing_order_as_saved(exclusions) -> None:
    layers = _map(exclusions)

    assert (layers.id, layers.name) == (tile_map_uri(0), "Stenavi")
    assert _rows(layers) == [
        ("ordinal_1", True, True, None, True),
        ("ordinal_1\\Facility_Merge_1", False, True, "Facility_Merge_*", False),
        ("ordinal_1\\POINT_FACILITY_1", False, True, "point_facility_*", False),
        ("ordinal_1\\JRSta_1F", True, True, None, True),
        ("ordinal_1\\JRSta_1F\\JRSta_1_Space", False, True, None, True),
        ("ordinal_1\\JRSta_1F\\JRSta_1_opening", False, True, "*_opening", False),
        ("ordinal_1\\JRSta_1F\\JRSta_1_level", False, False, "*_level", False),
        ("ordinal_-1", True, False, None, False),
        ("ordinal_-1\\JRSta_B1_Space", False, True, None, False),
        ("WiFi", True, True, "wifi", False),
        ("WiFi\\wifi_ap", False, True, None, False),
        ("編集用ネットワーク", False, True, "編集用ネットワーク", False),
        ("背景", False, True, None, True),
    ]
    assert [node.uri for node in layers.layers] == [
        tile_uri(name) for name in ("ordinal_1", "ordinal_-1", "WiFi", "編集用ネットワーク", "背景")
    ]


def test_without_patterns_the_default_is_what_the_project_draws_as_saved() -> None:
    assert default_selection(_map()) == {
        tile_uri(name)
        for name in ("Facility_Merge_1", "POINT_FACILITY_1", "JRSta_1_Space", "JRSta_1_opening", "wifi_ap", "編集用ネットワーク", "背景")
    }


def test_patterns_take_their_layers_and_a_matching_groups_layers_out_of_the_default(exclusions) -> None:
    assert default_selection(_map(exclusions)) == {tile_uri("JRSta_1_Space"), tile_uri("背景")}


@pytest.mark.parametrize(
    "name, pattern",
    [
        ("facility_merge_tap_B1", "Facility_Merge_*"),
        ("Point_Facility_Network_B2", "point_facility_network_*"),
        ("point_facility_B1", "point_facility_*"),
        ("JRShinjukuSta_B1_LEVEL", "*_level"),
        ("Merge_Tap", "merge_tap"),
        ("SUBNADE_1_opening", "*_opening"),
        ("WIFI", "wifi"),
        ("生成されたネットワーク", "生成されたネットワーク"),
        ("編集用ネットワーク", "編集用ネットワーク"),
        ("JRShinjukuSta_1_Space", None),
        ("merge_tap_old", None),
        ("level_names", None),
        ("wifi_ap", None),
        ("編集用ネットワーク2", None),
    ],
)
def test_the_shipped_patterns_ignore_case_and_name_the_first_that_matched(exclusions, name, pattern) -> None:
    assert exclusions.match(name) == pattern


def _patterns(tmp_path: Path, doc: object) -> Path:
    path = tmp_path / "exclusions.json"
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    "doc, message",
    [
        ({"exclude": ["wifi", "WiFi"]}, "'WiFi' repeats 'wifi'"),
        ({"exclude": [" wifi"]}, r"exclude\[0\] must be non-blank"),
        ({"exclude": [""]}, r"exclude\[0\] must be non-blank"),
        ({"exclude": ["*"]}, "would exclude every layer"),
        ({"exclude": "wifi"}, "must be a list"),
        ({"patterns": ["wifi"]}, "must be an object with an 'exclude' list"),
    ],
)
def test_a_broken_pattern_file_is_refused_at_load(tmp_path, doc, message) -> None:
    with pytest.raises(ValueError, match=message):
        load_tile_exclusions(_patterns(tmp_path, doc))


PLATFORMS = [("ホーム", True, [("Platform_1", True, None), ("Platform_2", True, None)])]
EXITS = [("Exit_A", True, None), ("Exit_B", False, None)]


def test_every_map_is_listed_and_the_only_one_with_layers_is_the_default() -> None:
    project = _maps(("マップ", []), ("マップ レイヤー", TILE_MAP))

    assert [(m.id, m.name, len(m.layers)) for m in project.maps] == [
        (tile_map_uri(0), "マップ", 0),
        (tile_map_uri(1), "マップ レイヤー", len(TILE_MAP)),
    ]
    assert (project.default_map, project.default_reason) == (tile_map_uri(1), "only_with_layers")
    assert project.chosen(None).name == "マップ レイヤー"


@pytest.mark.parametrize(
    "maps, default, reason",
    [
        ((("ホーム", PLATFORMS), ("マップ レイヤー", TILE_MAP)), 1, "most_layers"),
        ((("マップ レイヤー", TILE_MAP), ("ホーム", PLATFORMS)), 0, "most_layers"),
        ((("ホーム", PLATFORMS), ("出口", EXITS)), 0, "first_of_most"),
    ],
)
def test_with_several_maps_with_layers_the_default_has_the_most_and_comes_first_on_a_tie(maps, default, reason) -> None:
    project = _maps(*maps)

    assert (project.default_map, project.default_reason) == (tile_map_uri(default), reason)


@pytest.mark.parametrize("maps", [(), (("マップ", []), ("空", [("group", True, [])]))])
def test_a_project_whose_maps_have_no_layers_says_so(maps) -> None:
    assert read_project_layers(tile_project(maps=maps), NO_EXCLUSIONS, max_bytes=LIMIT) == NoMapLayers(
        maps=tuple(name for name, _ in maps)
    )


def test_the_plan_names_the_chosen_map_and_its_layers() -> None:
    project = _maps(("マップ レイヤー", TILE_MAP), ("ホーム", PLATFORMS))

    plan = tile_plan(project, tile_map_uri(1), None)

    assert (plan.map_uri, plan.map_name) == (tile_map_uri(1), "ホーム")
    assert [(line.name, line.visible) for line in plan.layers] == [
        ("ホーム", True),
        ("ホーム\\Platform_1", True),
        ("ホーム\\Platform_2", True),
    ]


@pytest.mark.parametrize(
    "map_id, selected, kind, message",
    [
        ("CIMPATH=gone/map.json", None, "unknown_map", "no map CIMPATH=gone/map.json; its maps are マップ"),
        (tile_map_uri(0), None, "empty_map", "'マップ' has no layers"),
        (tile_map_uri(2), {tile_uri("背景")}, "layers", "not in the map 'ホーム'"),
    ],
)
def test_a_map_that_cannot_be_tiled_or_layers_from_another_map_are_refused(map_id, selected, kind, message) -> None:
    project = _maps(("マップ", []), ("マップ レイヤー", TILE_MAP), ("ホーム", PLATFORMS))

    with pytest.raises(SelectionError, match=message) as refused:
        tile_plan(project, map_id, selected)

    assert refused.value.kind == kind


@pytest.mark.parametrize(
    "project, detail",
    [
        (b"not a zip", "Not a readable project"),
        (make_project([]), "no member GISProject.json"),
        (make_project([("GISProject.json", b"{", 8)]), "GISProject.json is not readable JSON"),
    ],
)
def test_an_unreadable_project_says_why(project, detail) -> None:
    layers = read_project_layers(project, NO_EXCLUSIONS, max_bytes=LIMIT)

    assert isinstance(layers, LayersUnreadable)
    assert detail in layers.detail


def test_a_project_past_the_upload_limit_is_not_read() -> None:
    assert read_project_layers(tile_project(), NO_EXCLUSIONS, max_bytes=100) == LayersUnreadable(
        detail="The project expands past the upload limit."
    )


def test_the_plan_draws_exactly_the_chosen_layers_and_the_groups_above_them(exclusions) -> None:
    layers = _map(exclusions)

    plan = visibility_plan(layers, {tile_uri("JRSta_B1_Space"), tile_uri("JRSta_1_opening")})

    assert {line.name: line.visible for line in plan} == {
        "ordinal_1": True,
        "ordinal_1\\Facility_Merge_1": False,
        "ordinal_1\\POINT_FACILITY_1": False,
        "ordinal_1\\JRSta_1F": True,
        "ordinal_1\\JRSta_1F\\JRSta_1_Space": False,
        "ordinal_1\\JRSta_1F\\JRSta_1_opening": True,
        "ordinal_1\\JRSta_1F\\JRSta_1_level": False,
        "ordinal_-1": True,
        "ordinal_-1\\JRSta_B1_Space": True,
        "WiFi": False,
        "WiFi\\wifi_ap": False,
        "編集用ネットワーク": False,
        "背景": False,
    }
    assert {line.uri for line in plan} == {node.uri for node, _ in walk(layers.layers)}


@pytest.mark.parametrize(
    "selected, message",
    [
        ({tile_uri("背景"), "CIMPATH=stenavi/gone.json"}, "not in the map 'Stenavi': CIMPATH=stenavi/gone.json"),
        ({tile_uri("ordinal_1")}, r"Choose layers, not groups: ordinal_1"),
        (set(), "at least one layer"),
    ],
)
def test_a_choice_naming_anything_but_the_maps_layers_is_refused(selected, message) -> None:
    with pytest.raises(SelectionError, match=message):
        visibility_plan(_map(), selected)
