"""ISO subdivision helpers, including Japanese prefecture name parse."""

from __future__ import annotations

from backend.src.iso_subdivisions import jp_prefecture_code


def test_jp_prefecture_code_keeps_an_iso_code() -> None:
    assert jp_prefecture_code("JP-01") == "JP-01"
    assert jp_prefecture_code("jp-13") == "JP-13"


def test_jp_prefecture_code_maps_nominatim_names() -> None:
    assert jp_prefecture_code("Hokkaidô") == "JP-01"
    assert jp_prefecture_code("Hokkaido") == "JP-01"
    assert jp_prefecture_code("北海道") == "JP-01"
    assert jp_prefecture_code("Chiba Prefecture") == "JP-12"
    assert jp_prefecture_code("千葉県") == "JP-12"
    assert jp_prefecture_code("東京都") == "JP-13"
    assert jp_prefecture_code("大阪府") == "JP-27"


def test_jp_prefecture_code_rejects_unknown_text() -> None:
    assert jp_prefecture_code(None) is None
    assert jp_prefecture_code("") is None
    assert jp_prefecture_code("California") is None
