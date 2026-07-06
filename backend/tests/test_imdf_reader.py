"""Tests for reading exported IMDF ZIP archives back into review sessions."""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from backend.src.converter import IMDF_TYPE_ORDER, build_imdf_geojson_files
from backend.src.imdf_reader import IMDF_FEATURE_TYPES, MAX_ARCHIVE_MEMBERS, read_imdf_zip


def _zip_bytes(entries: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buffer.getvalue()


def _feature(feature_type: str, feature_id: str) -> dict:
    return {
        "type": "Feature",
        "id": feature_id,
        "feature_type": feature_type,
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
        "properties": {"category": "unspecified"},
    }


@pytest.mark.phase6
def test_reader_recognises_every_exported_feature_type() -> None:
    assert IMDF_FEATURE_TYPES == set(IMDF_TYPE_ORDER)


@pytest.mark.phase6
def test_export_reopen_round_trip_keeps_extended_feature_types() -> None:
    payload = {
        "type": "FeatureCollection",
        "features": [
            _feature("unit", "u1"),
            _feature("amenity", "am1"),
            _feature("occupant", "oc1"),
            _feature("section", "se1"),
            _feature("kiosk", "ki1"),
        ],
    }
    files = build_imdf_geojson_files(payload)
    archive = _zip_bytes({name: json.dumps(fc) for name, fc in files.items()})

    result = read_imdf_zip(archive)
    types = {feat["feature_type"] for feat in result["features"]}
    assert {"unit", "amenity", "occupant", "section", "kiosk"} <= types


@pytest.mark.phase6
def test_reader_rejects_invalid_zip() -> None:
    with pytest.raises(ValueError, match="not a valid ZIP"):
        read_imdf_zip(b"this is not a zip file")


@pytest.mark.phase6
def test_reader_rejects_archive_exceeding_expanded_limit() -> None:
    big = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [_feature("unit", f"u{i}") for i in range(200)],
        }
    )
    archive = _zip_bytes({"unit.geojson": big})
    with pytest.raises(ValueError, match="Expanded upload exceeds"):
        read_imdf_zip(archive, max_uncompressed_bytes=1024)


@pytest.mark.phase6
def test_reader_rejects_archive_with_too_many_entries() -> None:
    entries = {f"junk_{i}.txt": "x" for i in range(MAX_ARCHIVE_MEMBERS + 1)}
    archive = _zip_bytes(entries)
    with pytest.raises(ValueError, match="entries"):
        read_imdf_zip(archive)
