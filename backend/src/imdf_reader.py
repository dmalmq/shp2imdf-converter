"""Read an exported IMDF ZIP archive back into a review-ready feature collection."""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any


IMDF_FEATURE_TYPES = {
    "address", "venue", "building", "footprint", "level",
    "unit", "opening", "fixture", "detail",
}


def read_imdf_zip(payload: bytes) -> dict[str, Any]:
    """Parse an IMDF ZIP and return a feature collection ready for the review screen.

    Accepts archives with GeoJSON files at the top level or inside a single folder.
    Adds review-only ``status`` and ``issues`` fields to each feature if absent.
    Raises ``ValueError`` if no recognised IMDF GeoJSON files are found.
    """
    features: list[dict[str, Any]] = []
    found_types: set[str] = set()

    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            basename = info.filename.rsplit("/", 1)[-1]
            if not basename.endswith(".geojson"):
                continue
            feature_type = basename[: -len(".geojson")]
            if feature_type not in IMDF_FEATURE_TYPES:
                continue

            with zf.open(info) as f:
                try:
                    fc = json.load(f)
                except json.JSONDecodeError:
                    continue

            found_types.add(feature_type)
            for feat in fc.get("features") or []:
                if not isinstance(feat, dict):
                    continue
                feat.setdefault("feature_type", feature_type)
                props = feat.get("properties")
                if not isinstance(props, dict):
                    feat["properties"] = props = {}
                props.setdefault("status", "mapped")
                props.setdefault("issues", [])
                features.append(feat)

    if not found_types:
        raise ValueError(
            "No recognised IMDF GeoJSON files found in the archive. "
            "Expected files named venue.geojson, unit.geojson, etc."
        )

    return {"type": "FeatureCollection", "features": features}
