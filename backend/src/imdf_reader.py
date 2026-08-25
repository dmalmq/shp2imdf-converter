"""Read an exported IMDF ZIP archive back into a review-ready feature collection."""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any

from backend.src.converter import IMDF_TYPE_ORDER


IMDF_FEATURE_TYPES = set(IMDF_TYPE_ORDER)

MAX_ARCHIVE_MEMBERS = 1_000


def read_imdf_zip(payload: bytes, max_uncompressed_bytes: int | None = None) -> dict[str, Any]:
    """Parse an IMDF ZIP and return a feature collection ready for the review screen.

    Accepts archives with GeoJSON files at the top level or inside a single folder.
    Adds review-only ``status`` and ``issues`` fields to each feature if absent.
    Raises ``ValueError`` for malformed archives, archives that exceed
    ``max_uncompressed_bytes`` when expanded, or archives with no recognised
    IMDF GeoJSON files.
    """
    features: list[dict[str, Any]] = []
    found_types: set[str] = set()
    remaining = max_uncompressed_bytes

    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded file is not a valid ZIP archive.") from exc

    with archive as zf:
        infos = zf.infolist()
        basenames = [info.filename.rsplit("/", 1)[-1] for info in infos if not info.is_dir()]

        # Say what is wrong before saying how big it is. The upload page offers
        # two buttons that both accept .zip, so a bundle of shapefiles arriving
        # here is the likeliest way to reach this function in error — and a
        # station's worth of them also trips the entry cap, which used to be the
        # only thing the user was told. Reading the central directory does not
        # decompress anything, so this costs nothing.
        if not any(name.endswith(".geojson") for name in basenames) and any(
            name.lower().endswith(".shp") for name in basenames
        ):
            raise ValueError(
                "This zip contains shapefiles, not an IMDF archive. Add it in the main upload "
                "area above and use Import & Continue; 'Open IMDF archive' is for re-opening a "
                "previously exported .imdf/.zip."
            )

        if len(infos) > MAX_ARCHIVE_MEMBERS:
            raise ValueError(
                f"Archive contains more than {MAX_ARCHIVE_MEMBERS} entries. An IMDF archive holds "
                "one .geojson per feature type, so this is probably not one."
            )
        for info in infos:
            if info.is_dir():
                continue
            basename = info.filename.rsplit("/", 1)[-1]
            if not basename.endswith(".geojson"):
                continue
            feature_type = basename[: -len(".geojson")]
            if feature_type not in IMDF_FEATURE_TYPES:
                continue

            with zf.open(info) as f:
                if remaining is not None:
                    # Cap the actual decompressed read; zip headers can understate size.
                    raw = f.read(remaining + 1)
                    if len(raw) > remaining:
                        raise ValueError("Expanded upload exceeds configured limit (MAX_UPLOAD_MB).")
                    remaining -= len(raw)
                else:
                    raw = f.read()
            try:
                fc = json.loads(raw)
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
