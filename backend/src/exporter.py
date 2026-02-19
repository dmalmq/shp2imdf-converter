"""Export helpers for IMDF archive payloads."""

from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
import json
import re
import zipfile

from backend.src.schemas import SessionRecord


IMDF_VERSION = "1.0.0"
GENERATED_BY = "shp2imdf-converter phase3"


def _utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_manifest(session: SessionRecord) -> dict[str, object]:
    language = "en"
    if session.wizard.project and session.wizard.project.language.strip():
        language = session.wizard.project.language.strip()
    return {
        "version": IMDF_VERSION,
        "created": _utc_now_iso(),
        "generated_by": GENERATED_BY,
        "language": language,
        "extensions": None,
    }


def _safe_export_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    return normalized.strip("._-") or "imdf_export"


def build_export_archive(session: SessionRecord) -> tuple[bytes, str]:
    output = BytesIO()
    manifest = build_manifest(session)

    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr(
            "features.geojson",
            json.dumps(session.feature_collection, ensure_ascii=False, indent=2),
        )

    project_name = session.wizard.project.project_name if session.wizard.project else None
    fallback = project_name or session.wizard.project.venue_name if session.wizard.project else session.session_id
    filename = f"{_safe_export_name(fallback)}.imdf"
    return output.getvalue(), filename

