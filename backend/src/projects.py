"""Project-level view of a shapefile session: name, stage and delivery state.

Everything here reads or updates the in-memory record only. The derived fields
land in the session index and its meta file, so listing never parses a record.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import os
from typing import Any, get_args

from backend.src.schemas import DeliveryRecord, SessionRecord, SessionStage as Stage, ValidationResponse

STAGES: tuple[str, ...] = get_args(Stage)


@dataclass(frozen=True)
class ProjectFields:
    name: str | None
    import_profile: str
    stage: Stage | None
    blockers: int | None
    can_wait: int | None
    updated_at: datetime | None
    changed_since_delivery: bool
    delivered_at: datetime | None
    delivered_format: str | None
    delivered_blockers: int | None

    def to_meta(self) -> dict[str, Any]:
        payload = asdict(self)
        for key in ("updated_at", "delivered_at"):
            value = payload[key]
            payload[key] = value.isoformat() if value is not None else None
        return payload

    @classmethod
    def from_meta(cls, payload: dict[str, Any]) -> ProjectFields:
        stage = payload.get("stage")
        return cls(
            name=_text(payload.get("name")),
            import_profile=_text(payload.get("import_profile")) or "standard",
            stage=stage if stage in STAGES else None,
            blockers=_count(payload.get("blockers")),
            can_wait=_count(payload.get("can_wait")),
            updated_at=_timestamp(payload.get("updated_at")),
            changed_since_delivery=payload.get("changed_since_delivery") is True,
            delivered_at=_timestamp(payload.get("delivered_at")),
            delivered_format=_text(payload.get("delivered_format")),
            delivered_blockers=_count(payload.get("delivered_blockers")),
        )


def derive_session_project(record: SessionRecord) -> ProjectFields:
    validation = current_validation(record)
    delivered = record.delivered
    changed_since_delivery = delivered is not None and record.content_rev > delivered.rev
    return ProjectFields(
        name=_project_name(record),
        import_profile=record.import_profile,
        stage=_stage(record, validation, changed_since_delivery),
        blockers=validation.summary.error_count if validation is not None else None,
        can_wait=validation.summary.warning_count if validation is not None else None,
        updated_at=record.content_changed_at or record.created_at,
        changed_since_delivery=changed_since_delivery,
        delivered_at=delivered.at if delivered is not None else None,
        delivered_format=delivered.format if delivered is not None else None,
        delivered_blockers=delivered.blockers if delivered is not None else None,
    )


def current_validation(record: SessionRecord) -> ValidationResponse | None:
    if record.validation is None or record.validation_rev != record.content_rev:
        return None
    return record.validation


def mark_changed(record: SessionRecord) -> None:
    record.content_rev += 1
    record.content_changed_at = datetime.now(UTC)


def reset_generation(record: SessionRecord) -> None:
    record.wizard.generation_status = "not_started"
    record.validation = None
    record.validation_rev = None
    mark_changed(record)


def setup_snapshot(record: SessionRecord) -> str:
    """What a wizard request can change, less the generation status it resets.

    File level names are left out: the levels section copies them from
    ``wizard.levels.items``, which is compared and is what generation reads,
    so the first sync of seeded names fills them without changing any output.
    """
    wizard = record.wizard.model_dump_json(exclude={"generation_status"})
    files = "".join(item.model_dump_json(exclude={"level_name", "short_name"}) for item in record.files)
    return wizard + files


def reset_generation_if_changed(record: SessionRecord, before: str) -> bool:
    """The wizard re-sends unchanged sections on every visit; only a real change counts."""
    if setup_snapshot(record) == before:
        return False
    reset_generation(record)
    return True


def mark_validated(record: SessionRecord, validation: ValidationResponse) -> None:
    record.validation = validation
    record.validation_rev = record.content_rev


def mark_delivered(record: SessionRecord, export_format: str, blockers: int | None) -> None:
    record.delivered = DeliveryRecord(
        at=datetime.now(UTC),
        rev=record.content_rev,
        format=export_format,
        blockers=blockers,
    )


def _stage(record: SessionRecord, validation: ValidationResponse | None, changed_since_delivery: bool) -> Stage:
    if record.delivered is not None and not changed_since_delivery:
        return "deliver"
    if record.wizard.generation_status == "not_started":
        return "set-up" if record.wizard.project is not None else "bring-in"
    if validation is not None and validation.summary.error_count == 0:
        return "deliver"
    return "check"


def _project_name(record: SessionRecord) -> str | None:
    project = record.wizard.project
    if project is not None:
        for candidate in (project.project_name, project.venue_name):
            if text := _text(candidate):
                return text
    if venue_name := _venue_feature_name(record.feature_collection):
        return venue_name
    stems = [item.stem for item in record.files if item.stem]
    prefix = os.path.commonprefix(stems).rstrip(" _-.")
    return prefix or None


def _venue_feature_name(collection: dict[str, Any]) -> str | None:
    features = collection.get("features") if isinstance(collection, dict) else None
    if not isinstance(features, list):
        return None
    for feature in features:
        if not isinstance(feature, dict) or feature.get("feature_type") != "venue":
            continue
        properties = feature.get("properties")
        name = properties.get("name") if isinstance(properties, dict) else None
        if isinstance(name, dict):
            for value in name.values():
                if text := _text(value):
                    return text
        elif text := _text(name):
            return text
    return None


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
