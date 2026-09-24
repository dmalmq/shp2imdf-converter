"""Project identity for an artwork (Illustrator) conversion.

A conversion's ``project.json`` sidecar holds what the project list needs without
opening the artwork: a name, when it last changed, when it was last delivered,
and how many of its floors are placed. The stage is derived from those, never
stored, so it cannot drift from the files it describes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Literal

ArtworkStage = Literal["name-floors", "place", "deliver"]

NAME_MAX_LENGTH = 120


@dataclass(slots=True)
class ArtworkProject:
    name: str
    updated_at: str | None = None
    delivered_at: str | None = None
    floors_total: int = 0
    floors_placed: int = 0

    @classmethod
    def from_dict(cls, payload: Any, default_name: str) -> ArtworkProject:
        """Read a sidecar leniently: a missing or malformed field takes its default."""
        if not isinstance(payload, dict):
            return cls(name=default_name)
        name = payload.get("name")
        return cls(
            name=name if isinstance(name, str) and name.strip() else default_name,
            updated_at=_optional_str(payload.get("updated_at")),
            delivered_at=_optional_str(payload.get("delivered_at")),
            floors_total=_count(payload.get("floors_total")),
            floors_placed=_count(payload.get("floors_placed")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def normalise_project_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise ValueError("A project name cannot be blank.")
    if len(name) > NAME_MAX_LENGTH:
        raise ValueError(f"A project name can be at most {NAME_MAX_LENGTH} characters.")
    return name


def derive_artwork_stage(
    *,
    has_floors: bool,
    floors_total: int,
    floors_placed: int,
    delivered_at: str | None,
) -> tuple[ArtworkStage, int | None]:
    """Return ``(stage, blockers)``; blockers is the number of floors still to place.

    A floor counts as placed once it is pinned, has enough control points, or is
    marked done. A station pin alone does not count: it is set automatically.
    """
    if delivered_at:
        return "deliver", 0
    if has_floors:
        if floors_total <= 0:
            return "place", None
        remaining = max(0, floors_total - floors_placed)
        return ("deliver", 0) if remaining == 0 else ("place", remaining)
    return "name-floors", None


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)
