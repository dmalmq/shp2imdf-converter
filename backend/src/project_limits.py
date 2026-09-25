"""How long projects stay on the shared PC, and how many each flow keeps.

Both flows, shapefile sessions and artwork conversions, keep a project for
``PROJECT_IDLE_DAYS`` after it was last opened and at most ``MAX_PROJECTS`` of
them. At the cap the oldest last-opened project goes first; a delivered project
whose content has not changed since only goes first on a tie, so an abandoned
test upload never outlives a delivered project someone is still reworking.
Nothing opened in the last 24 hours is evicted: the store runs over the cap
instead, because losing a colleague's work in progress is worse than disk.

The settings that predate this (``SESSION_TTL_HOURS``, ``MAX_SESSIONS``,
``ILLUSTRATOR_CACHE_TTL_MINUTES``, ``ILLUSTRATOR_CACHE_MAX_ENTRIES``) still win
when set, so an existing deployment keeps its behaviour until someone removes
them; startup warns with the values in force.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
import os
from typing import TypeVar

DEFAULT_IDLE_DAYS = 30
DEFAULT_MAX_PROJECTS = 200
PROTECTED_SECONDS = 24 * 3600
ORPHAN_UPLOAD_SECONDS = 24 * 3600

_DAY = 24 * 3600

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class FlowLimits:
    idle_seconds: float
    max_projects: int
    legacy_settings: tuple[str, ...] = ()

    def describe(self) -> str:
        return f"kept {describe_duration(self.idle_seconds)} after last opened, at most {self.max_projects}"

    def to_dict(self) -> dict:
        return {
            "idle_seconds": self.idle_seconds,
            "max_projects": self.max_projects,
            "legacy_settings": list(self.legacy_settings),
        }


@dataclass(frozen=True, slots=True)
class ProjectLimits:
    sessions: FlowLimits
    artwork: FlowLimits
    protected_seconds: float = PROTECTED_SECONDS
    orphan_upload_seconds: float = ORPHAN_UPLOAD_SECONDS

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> ProjectLimits:
        env = os.environ if env is None else env
        idle_seconds = _positive(env, "PROJECT_IDLE_DAYS", float, DEFAULT_IDLE_DAYS) * _DAY
        max_projects = _positive(env, "MAX_PROJECTS", int, DEFAULT_MAX_PROJECTS)
        return cls(
            sessions=_flow(
                env, idle_seconds, max_projects, ("SESSION_TTL_HOURS", 3600), "MAX_SESSIONS"
            ),
            artwork=_flow(
                env,
                idle_seconds,
                max_projects,
                ("ILLUSTRATOR_CACHE_TTL_MINUTES", 60),
                "ILLUSTRATOR_CACHE_MAX_ENTRIES",
            ),
        )

    def describe(self) -> str:
        return (
            f"Project lifetimes: shapefile sessions {self.sessions.describe()}; "
            f"artwork conversions {self.artwork.describe()}; nothing opened in the last "
            f"{describe_duration(self.protected_seconds)} is evicted."
        )

    def legacy_warnings(self, env: Mapping[str, str] | None = None) -> list[str]:
        env = os.environ if env is None else env
        warnings = []
        for label, flow in (("Shapefile sessions", self.sessions), ("Artwork conversions", self.artwork)):
            if not flow.legacy_settings:
                continue
            named = ", ".join(f"{name}={env.get(name, '').strip()}" for name in flow.legacy_settings)
            warnings.append(
                f"Old setting in force instead of PROJECT_IDLE_DAYS/MAX_PROJECTS: {named}. "
                f"{label} are {flow.describe()}. Remove it to use the new settings."
            )
        return warnings

    def to_dict(self) -> dict:
        return {
            "sessions": self.sessions.to_dict(),
            "artwork": self.artwork.to_dict(),
            "protected_seconds": self.protected_seconds,
            "orphan_upload_seconds": self.orphan_upload_seconds,
        }


def select_evictions(
    entries: Iterable[T],
    surplus: int,
    *,
    now: float,
    last_opened: Callable[[T], float],
    delivered_and_unchanged: Callable[[T], bool],
    protected_seconds: float = PROTECTED_SECONDS,
) -> list[T]:
    """Up to ``surplus`` entries to evict: oldest last opened first, never a protected one.

    Fewer than ``surplus`` come back when the rest were opened too recently.
    """
    if surplus <= 0:
        return []
    candidates = [entry for entry in entries if now - last_opened(entry) >= protected_seconds]
    candidates.sort(key=lambda entry: (last_opened(entry), not delivered_and_unchanged(entry)))
    return candidates[:surplus]


def describe_duration(seconds: float) -> str:
    if seconds >= 2 * _DAY and seconds % _DAY == 0:
        return f"{int(seconds // _DAY)} days"
    for unit, name in ((3600, "h"), (60, "min")):
        if seconds >= unit and seconds % unit == 0:
            return f"{int(seconds // unit)} {name}"
    return f"{seconds:g} s"


def _flow(
    env: Mapping[str, str],
    idle_seconds: float,
    max_projects: int,
    legacy_idle: tuple[str, int],
    legacy_max: str,
) -> FlowLimits:
    legacy = []
    idle_name, idle_unit = legacy_idle
    if _is_set(env, idle_name):
        idle_seconds = _positive(env, idle_name, float, 0) * idle_unit
        legacy.append(idle_name)
    if _is_set(env, legacy_max):
        max_projects = _positive(env, legacy_max, int, 0)
        legacy.append(legacy_max)
    return FlowLimits(idle_seconds, max_projects, tuple(legacy))


def _is_set(env: Mapping[str, str], name: str) -> bool:
    return bool(env.get(name, "").strip())


def _positive(env: Mapping[str, str], name: str, cast: type, default: float) -> float:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = cast(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None
    if value <= 0:
        raise ValueError(f"{name} must be greater than 0, got {raw!r}")
    return value
