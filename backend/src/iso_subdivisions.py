"""ISO 3166-1 / 3166-2 helpers backed by pycountry.

IMDF's ``address`` feature requires ``country`` to be an ISO 3166-1 alpha-2 code
(e.g. ``"JP"``) and ``province`` to be a full ISO 3166-2 subdivision code
(e.g. ``"JP-01"``, i.e. ``<country>-<subdivision>``). These helpers back both the
Review-step validation and the province picker reference endpoint so there is a
single source of truth for valid codes.
"""

from __future__ import annotations

import unicodedata

import pycountry

_JA_PREFECTURE_STEMS: dict[str, str] = {
    "北海道": "JP-01",
    "青森": "JP-02",
    "岩手": "JP-03",
    "宮城": "JP-04",
    "秋田": "JP-05",
    "山形": "JP-06",
    "福島": "JP-07",
    "茨城": "JP-08",
    "栃木": "JP-09",
    "群馬": "JP-10",
    "埼玉": "JP-11",
    "千葉": "JP-12",
    "東京": "JP-13",
    "神奈川": "JP-14",
    "新潟": "JP-15",
    "富山": "JP-16",
    "石川": "JP-17",
    "福井": "JP-18",
    "山梨": "JP-19",
    "長野": "JP-20",
    "岐阜": "JP-21",
    "静岡": "JP-22",
    "愛知": "JP-23",
    "三重": "JP-24",
    "滋賀": "JP-25",
    "京都": "JP-26",
    "大阪": "JP-27",
    "兵庫": "JP-28",
    "奈良": "JP-29",
    "和歌山": "JP-30",
    "鳥取": "JP-31",
    "島根": "JP-32",
    "岡山": "JP-33",
    "広島": "JP-34",
    "山口": "JP-35",
    "徳島": "JP-36",
    "香川": "JP-37",
    "愛媛": "JP-38",
    "高知": "JP-39",
    "福岡": "JP-40",
    "佐賀": "JP-41",
    "長崎": "JP-42",
    "熊本": "JP-43",
    "大分": "JP-44",
    "宮崎": "JP-45",
    "鹿児島": "JP-46",
    "沖縄": "JP-47",
}


def normalize_country(country: str | None) -> str | None:
    """Return an upper-cased, trimmed alpha-2 country code, or ``None``."""
    if not country:
        return None
    return country.strip().upper() or None


def normalize_subdivision(code: str | None) -> str | None:
    """Return an upper-cased, trimmed ISO 3166-2 code, or ``None``."""
    if not code:
        return None
    return code.strip().upper() or None


def is_valid_country(country: str | None) -> bool:
    code = normalize_country(country)
    if not code:
        return False
    return pycountry.countries.get(alpha_2=code) is not None


def is_valid_subdivision(code: str | None) -> bool:
    normalized = normalize_subdivision(code)
    if not normalized:
        return False
    return pycountry.subdivisions.get(code=normalized) is not None


def subdivisions_for_country(country: str | None) -> list[dict[str, str]]:
    """Return ``[{"code", "name"}, ...]`` for a country, sorted by code.

    Empty when the country is unknown or has no listed subdivisions.
    """
    code = normalize_country(country)
    if not code:
        return []
    subdivisions = pycountry.subdivisions.get(country_code=code) or []
    items = [{"code": sub.code, "name": sub.name} for sub in subdivisions]
    items.sort(key=lambda item: item["code"])
    return items


def _fold_latin(value: str) -> str:
    nfkd = unicodedata.normalize("NFKD", value)
    folded = "".join(char for char in nfkd if not unicodedata.combining(char)).casefold()
    for suffix in (" prefecture", " prefect.", " pref."):
        if folded.endswith(suffix):
            folded = folded[: -len(suffix)]
            break
    return folded.replace(" ", "")


def _ja_stem(value: str) -> str:
    for suffix in ("都", "府", "県"):
        if len(value) > 1 and value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def jp_prefecture_code(province: str | None) -> str | None:
    """Return ``JP-xx`` from an ISO code or a Nominatim prefecture name."""
    if not province:
        return None
    text = province.strip()
    if not text:
        return None
    if is_valid_subdivision(text):
        return normalize_subdivision(text)
    ja = _ja_stem(text)
    if ja in _JA_PREFECTURE_STEMS:
        return _JA_PREFECTURE_STEMS[ja]
    folded = _fold_latin(text)
    for sub in pycountry.subdivisions.get(country_code="JP") or []:
        if _fold_latin(sub.name) == folded:
            return sub.code
    return None
