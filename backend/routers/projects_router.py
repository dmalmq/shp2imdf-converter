"""The project list behind the hub: shapefile sessions and artwork conversions together.

Everything here reads the session index and the conversion metadata only. It never
loads a session record and never calls either store's ``get``, which would touch
(so keep alive) or discard (so delete) what is merely being listed. The path sits
outside ``/api/session/...``, so listing never waits behind a session's edit lock.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request

from backend.src.artwork_projects import delivery_is_current
from backend.src.errors import SessionNotFoundError
from backend.src.illustrator_store import ConversionStore, ConversionSummary
from backend.src.project_limits import FlowLimits, ProjectLimits
from backend.src.schemas import (
    ProjectFlow,
    ProjectLimitsByFlow,
    ProjectListLimits,
    ProjectListResponse,
    ProjectSummary,
)
from backend.src.session import SessionManager, SessionSummary, is_session_id

router = APIRouter(prefix="/api/projects", tags=["projects"])

_SECONDS_PER_DAY = 86400.0
_EPOCH = datetime.fromtimestamp(0, UTC)


@router.get("", response_model=ProjectListResponse)
def list_projects(
    request: Request,
    flow: ProjectFlow | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> ProjectListResponse:
    projects = _collect(request, flow)
    projects.sort(key=lambda item: (-(item.last_opened - _EPOCH).total_seconds(), item.id))
    return ProjectListResponse(
        projects=projects[:limit],
        total=len(projects),
        limits=_effective_limits(request),
    )


@router.get("/{flow}/{project_id}", response_model=ProjectSummary)
def get_project(flow: ProjectFlow, project_id: str, request: Request) -> ProjectSummary:
    if flow == "shapefiles":
        manager = _sessions(request)
        summary = manager.backend.summary(project_id) if is_session_id(project_id) else None
        if summary is None:
            raise SessionNotFoundError()
        return _session_project(summary, manager)
    return _artwork_project(_conversions(request).summary(project_id))


def _collect(request: Request, flow: ProjectFlow | None) -> list[ProjectSummary]:
    projects: list[ProjectSummary] = []
    if flow in (None, "shapefiles"):
        manager = _sessions(request)
        now = datetime.now(UTC)
        # Past its lifetime a session is gone at the next prune, so it is not offered,
        # matching the conversion store, which skips its expired entries.
        projects.extend(
            project
            for project in (_session_project(item, manager) for item in manager.backend.list_summaries())
            if project.expires_at > now
        )
    if flow in (None, "artwork"):
        projects.extend(_artwork_project(item) for item in _conversions(request).list_summaries())
    return projects


def _effective_limits(request: Request) -> ProjectLimitsByFlow:
    """The limits the stores were built with, legacy overrides included, per flow."""
    limits: ProjectLimits = request.app.state.project_limits
    return ProjectLimitsByFlow(sessions=_list_limits(limits.sessions), artwork=_list_limits(limits.artwork))


def _list_limits(flow: FlowLimits) -> ProjectListLimits:
    return ProjectListLimits(idle_days=flow.idle_seconds / _SECONDS_PER_DAY, max_projects=flow.max_projects)


def _session_project(summary: SessionSummary, manager: SessionManager) -> ProjectSummary:
    last_opened = _aware(summary.last_accessed)
    project = summary.project
    return ProjectSummary(
        id=summary.session_id,
        flow="shapefiles",
        name=project.name if project else None,
        import_profile=project.import_profile if project else None,
        stage=project.stage if project else None,
        updated_at=project.updated_at if project else None,
        last_opened=last_opened,
        blockers=project.blockers if project else None,
        can_wait=project.can_wait if project else None,
        delivered_at=project.delivered_at if project else None,
        changed_since_delivery=project.changed_since_delivery if project else False,
        expires_at=last_opened + manager.ttl,
    )


def _artwork_project(summary: ConversionSummary) -> ProjectSummary:
    delivered_at = _parse(summary.delivered_at)
    return ProjectSummary(
        id=summary.conversion_id,
        flow="artwork",
        name=summary.name,
        import_profile=None,
        stage=summary.stage,
        updated_at=_parse(summary.updated_at),
        last_opened=datetime.fromtimestamp(summary.last_used_at, UTC),
        blockers=summary.blockers,
        can_wait=None,
        delivered_at=delivered_at,
        changed_since_delivery=delivered_at is not None
        and not delivery_is_current(summary.delivered_at, summary.content_changed_at),
        expires_at=datetime.fromtimestamp(summary.expires_at, UTC),
    )


def _sessions(request: Request) -> SessionManager:
    return request.app.state.session_manager


def _conversions(request: Request) -> ConversionStore:
    return request.app.state.illustrator_store


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return _aware(datetime.fromisoformat(value))
    except ValueError:
        return None
