"""What happened on a project, visit by visit, for the Welcome back view.

A visit is a run of requests to one session with no gap of ``visit_gap()`` or
more between them. There is no identity: two people on one project at once
share a visit. Only edits are recorded, so a visit with none leaves nothing.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import math
import os

from backend.src.schemas import Handover, HandoverEvent, HandoverEventKind, HandoverNote, HandoverVisit

MAX_VISITS = 20
MAX_EVENTS_PER_VISIT = 40
DEFAULT_VISIT_GAP_MINUTES = 30.0
# Six seconds is for live checks; a week is longer than anyone leaves a project mid-task.
MIN_VISIT_GAP_MINUTES = 0.1
MAX_VISIT_GAP_MINUTES = 7 * 24 * 60.0
GAP_SETTING = "HANDOVER_VISIT_GAP_MINUTES"


def _gap_minutes() -> tuple[float, str | None]:
    raw = os.getenv(GAP_SETTING, "").strip()
    if not raw:
        return DEFAULT_VISIT_GAP_MINUTES, None
    try:
        minutes = float(raw)
    except ValueError:
        minutes = math.nan
    if not math.isfinite(minutes) or not MIN_VISIT_GAP_MINUTES <= minutes <= MAX_VISIT_GAP_MINUTES:
        return DEFAULT_VISIT_GAP_MINUTES, (
            f"{GAP_SETTING}={raw!r} is not a number of minutes from {MIN_VISIT_GAP_MINUTES:g} "
            f"to {MAX_VISIT_GAP_MINUTES:g}; using {DEFAULT_VISIT_GAP_MINUTES:g}"
        )
    return minutes, None


def visit_gap() -> timedelta:
    return timedelta(minutes=_gap_minutes()[0])


def gap_setting_problem() -> str | None:
    return _gap_minutes()[1]


def begin_or_continue_visit(handover: Handover, previous: datetime, now: datetime) -> bool:
    """Returns whether a new visit began, which the caller must persist."""
    current = _current_visit(handover)
    if handover.visit_started_at is None or now - previous >= visit_gap():
        if current is not None:
            current.ended_at = max(current.ended_at, previous)
        handover.visit_started_at = now
        return True
    if current is not None:
        current.ended_at = max(current.ended_at, now)
    return False


def record_event(handover: Handover, kind: HandoverEventKind, now: datetime, n: int = 1, **params: str | int) -> None:
    visit = _current_visit(handover)
    if visit is not None and now - visit.ended_at >= visit_gap():
        handover.visit_started_at = now
        visit = None
    if visit is None:
        started = handover.visit_started_at or now
        handover.visit_started_at = started
        visit = HandoverVisit(started_at=started, ended_at=now)
        handover.visits.append(visit)
        del handover.visits[:-MAX_VISITS]
    visit.ended_at = max(visit.ended_at, now)
    same = next(
        (event for event in visit.events if event.kind == kind and event.params == params),
        None,
    )
    if same is not None:
        visit.events.remove(same)
        same.n += n
        same.at = now
        visit.events.append(same)
        return
    visit.events.append(HandoverEvent(at=now, kind=kind, n=n, params=params))
    surplus = len(visit.events) - MAX_EVENTS_PER_VISIT
    if surplus > 0:
        del visit.events[:surplus]
        visit.dropped += surplus


def last_visit(handover: Handover) -> HandoverVisit | None:
    started = handover.visit_started_at
    return next(
        (visit for visit in reversed(handover.visits) if started is None or visit.started_at < started),
        None,
    )


def set_note(handover: Handover, text: str, now: datetime) -> None:
    stripped = text.strip()
    handover.note = HandoverNote(text=stripped, at=now) if stripped else None


def _current_visit(handover: Handover) -> HandoverVisit | None:
    if not handover.visits or handover.visit_started_at is None:
        return None
    visit = handover.visits[-1]
    return visit if visit.started_at == handover.visit_started_at else None
