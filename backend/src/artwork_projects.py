"""Project identity for an artwork (Illustrator) conversion.

A conversion's ``project.json`` sidecar holds what the project list needs without
opening the artwork: a name, when it last changed, when it was last delivered,
and how many of its floors are placed. The stage is derived from those, never
stored, so it cannot drift from the files it describes.

``updated_at`` moves on any edit, a rename included. ``content_changed_at``
moves only when what an export would contain changes (a new upload or a new
floor assignment), so a delivery is current while it is not older than that.
"""

from __future__ import annotations

import unicodedata
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Literal

ArtworkStage = Literal["name-floors", "place", "deliver"]

NAME_MAX_LENGTH = 120

# Categories that render as nothing or rearrange their neighbours: controls,
# format characters (zero-width joiners, bidi overrides), private use,
# unassigned and surrogates, and line/paragraph separators.
_INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Co", "Cn", "Cs", "Zl", "Zp"})
# Letters by category that still render blank (Hangul fillers, braille blank).
_BLANK_LETTERS = frozenset({"ᅟ", "ᅠ", "ㅤ", "ﾠ", "⠀"})


@dataclass(slots=True)
class ArtworkProject:
    name: str
    updated_at: str | None = None
    content_changed_at: str | None = None
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
            content_changed_at=_optional_str(payload.get("content_changed_at")),
            delivered_at=_optional_str(payload.get("delivered_at")),
            floors_total=_count(payload.get("floors_total")),
            floors_placed=_count(payload.get("floors_placed")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def normalise_project_name(raw: str) -> str:
    name = unicodedata.normalize("NFC", raw).strip()
    if not name:
        raise ValueError("A project name cannot be blank.")
    if len(name) > NAME_MAX_LENGTH:
        raise ValueError(f"A project name can be at most {NAME_MAX_LENGTH} characters.")
    hidden = sorted(
        {
            f"U+{ord(char):04X}"
            for char in name
            if char in _BLANK_LETTERS or unicodedata.category(char) in _INVISIBLE_CATEGORIES
        }
    )
    if hidden:
        raise ValueError(
            "A project name cannot contain invisible or control characters: " + ", ".join(hidden)
        )
    return name


def delivery_is_current(delivered_at: str | None, content_changed_at: str | None) -> bool:
    """True when the last delivery is not older than the last content change."""
    delivered = _parse(delivered_at)
    if delivered is None:
        return False
    changed = _parse(content_changed_at)
    return changed is None or delivered >= changed


def derive_artwork_stage(
    *,
    has_floors: bool,
    floors_total: int,
    floors_placed: int,
    delivered_at: str | None,
    content_changed_at: str | None = None,
) -> tuple[ArtworkStage, int | None]:
    """Return ``(stage, blockers)``; blockers is the number of floors still to place.

    A floor counts as placed once it is pinned, has enough control points, or is
    marked done. A station pin alone does not count: it is set automatically.
    """
    if delivery_is_current(delivered_at, content_changed_at):
        return "deliver", 0
    if has_floors:
        if floors_total <= 0:
            return "place", None
        remaining = max(0, floors_total - floors_placed)
        return ("deliver", 0) if remaining == 0 else ("place", remaining)
    return "name-floors", None


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)
