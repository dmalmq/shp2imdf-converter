"""Wizard configuration endpoints for Phase 3."""

from __future__ import annotations

from collections import Counter
import json
from typing import Annotated, Any

from fastapi import APIRouter, File, Request, UploadFile

from backend.src.mapper import (
    build_unit_code_preview,
    detect_candidate_columns,
    load_unit_categories,
    normalize_company_mappings_payload,
)
from backend.src.schemas import (
    BuildingsWizardRequest,
    BuildingsWizardResponse,
    CompanyMappingsUploadResponse,
    FootprintWizardRequest,
    LevelsWizardRequest,
    MappingsWizardRequest,
    ProjectWizardRequest,
    ProjectWizardResponse,
    SessionRecord,
    WizardStateResponse,
)
from backend.src.session import SessionManager
from backend.src.wizard import build_address_feature, seed_wizard_state


router = APIRouter(prefix="/api/session/{session_id}", tags=["wizard"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def _unit_categories_path(request: Request) -> str:
    return str(request.app.state.unit_categories_path)


def _set_default_unit_mapping_column(session: SessionRecord) -> None:
    if session.wizard.mappings.unit.code_column:
        return

    candidates = detect_candidate_columns(session.files, feature_type="unit")
    if not candidates:
        return

    preferred = ["CATEGORY", "COMPANY_CO", "COMPANY_CODE", "TYPE"]
    candidate_lookup = {item.upper(): item for item in candidates}
    for key in preferred:
        if key in candidate_lookup:
            session.wizard.mappings.unit.code_column = candidate_lookup[key]
            return
    session.wizard.mappings.unit.code_column = candidates[0]


def _refresh_unit_preview(session: SessionRecord, request: Request) -> tuple[int, int]:
    valid_categories, config_default = load_unit_categories(_unit_categories_path(request))
    default_category = session.wizard.company_default_category or config_default
    if default_category not in valid_categories:
        default_category = config_default

    preview = build_unit_code_preview(
        feature_collection=session.feature_collection,
        files=session.files,
        code_column=session.wizard.mappings.unit.code_column,
        company_mappings=session.wizard.company_mappings,
        valid_categories=valid_categories,
        default_category=default_category,
    )
    session.wizard.mappings.unit.preview = preview
    unresolved = sum(1 for item in preview if item.unresolved)
    return len(preview), unresolved


def _get_session_or_raise(session_id: str, request: Request) -> SessionRecord:
    session = _session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")
    return session


@router.get("/wizard", response_model=WizardStateResponse)
def get_wizard_state(session_id: str, request: Request) -> WizardStateResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)
    _set_default_unit_mapping_column(session)
    _refresh_unit_preview(session, request)
    manager.save_session(session)
    return WizardStateResponse(session_id=session_id, wizard=session.wizard)


@router.patch("/wizard/project", response_model=ProjectWizardResponse)
def patch_wizard_project(session_id: str, payload: ProjectWizardRequest, request: Request) -> ProjectWizardResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)

    if not payload.venue_name.strip():
        raise ValueError("venue_name is required")
    if not payload.venue_category.strip():
        raise ValueError("venue_category is required")
    if not payload.address.locality.strip():
        raise ValueError("address.locality is required")
    if not payload.address.country.strip():
        raise ValueError("address.country is required")

    session.wizard.project = payload
    session.wizard.venue_address_feature = build_address_feature(payload.address, fallback_name=payload.venue_name)
    if not (payload.address.address or "").strip():
        session.wizard.warnings = [
            "Venue street address is blank; venue name will be used as the address line."
        ]
    else:
        session.wizard.warnings = []
    session.wizard.generation_status = "not_started"

    manager.save_session(session)
    return ProjectWizardResponse(
        session_id=session_id,
        wizard=session.wizard,
        address_feature=session.wizard.venue_address_feature,
    )


@router.patch("/wizard/levels", response_model=WizardStateResponse)
def patch_wizard_levels(session_id: str, payload: LevelsWizardRequest, request: Request) -> WizardStateResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)

    session.wizard.levels.items = payload.items

    by_stem = {item.stem: item for item in payload.items}
    updated_files = []
    for file in session.files:
        item = by_stem.get(file.stem)
        if not item:
            updated_files.append(file)
            continue
        updated = file.model_copy(deep=True)
        if item.ordinal is not None:
            updated.detected_level = item.ordinal
        if item.name is not None:
            updated.level_name = item.name
        if item.short_name is not None:
            updated.short_name = item.short_name
        updated.outdoor = item.outdoor
        updated.level_category = item.category or "unspecified"
        updated_files.append(updated)
    session.files = updated_files
    session.wizard.generation_status = "not_started"

    manager.save_session(session)
    return WizardStateResponse(session_id=session_id, wizard=session.wizard)


@router.patch("/wizard/buildings", response_model=BuildingsWizardResponse)
def patch_wizard_buildings(
    session_id: str,
    payload: BuildingsWizardRequest,
    request: Request,
) -> BuildingsWizardResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)

    ids = [item.id for item in payload.buildings]
    duplicate_ids = [identifier for identifier, count in Counter(ids).items() if count > 1]
    if duplicate_ids:
        raise ValueError(f"Duplicate building ids are not allowed: {', '.join(sorted(duplicate_ids))}")

    project = session.wizard.project
    venue_name = project.venue_name if project else None
    building_rows = []
    address_features: list[dict[str, Any]] = []
    for building in payload.buildings:
        updated = building.model_copy(deep=True)
        if updated.address_mode == "different_address":
            if updated.address is None:
                raise ValueError(f"Building '{updated.id}' requires an address when address_mode=different_address")
            feature = build_address_feature(updated.address, fallback_name=updated.name or venue_name)
            updated.address_feature_id = str(feature["id"])
            address_features.append(feature)
        else:
            updated.address = None
            updated.address_feature_id = None
        building_rows.append(updated)

    session.wizard.buildings = building_rows
    session.wizard.building_address_features = address_features
    session.wizard.generation_status = "not_started"

    manager.save_session(session)
    return BuildingsWizardResponse(
        session_id=session_id,
        wizard=session.wizard,
        address_features=address_features,
    )


@router.patch("/wizard/mappings", response_model=WizardStateResponse)
def patch_wizard_mappings(
    session_id: str,
    payload: MappingsWizardRequest,
    request: Request,
) -> WizardStateResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)

    if payload.unit is not None:
        session.wizard.mappings.unit = payload.unit
    if payload.opening is not None:
        session.wizard.mappings.opening = payload.opening
    if payload.fixture is not None:
        session.wizard.mappings.fixture = payload.fixture
    if payload.detail_confirmed is not None:
        session.wizard.mappings.detail_confirmed = payload.detail_confirmed

    _set_default_unit_mapping_column(session)
    _refresh_unit_preview(session, request)
    session.wizard.generation_status = "not_started"
    manager.save_session(session)
    return WizardStateResponse(session_id=session_id, wizard=session.wizard)


@router.patch("/wizard/footprint", response_model=WizardStateResponse)
def patch_wizard_footprint(
    session_id: str,
    payload: FootprintWizardRequest,
    request: Request,
) -> WizardStateResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)
    session.wizard.footprint = payload
    session.wizard.generation_status = "not_started"
    manager.save_session(session)
    return WizardStateResponse(session_id=session_id, wizard=session.wizard)


@router.post("/config/company-mappings", response_model=CompanyMappingsUploadResponse)
async def upload_company_mappings(
    session_id: str,
    request: Request,
    file: Annotated[UploadFile, File(description="company_mappings.json")],
) -> CompanyMappingsUploadResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    seed_wizard_state(session)

    payload_raw = await file.read()
    if not payload_raw:
        raise ValueError("Uploaded company mappings file is empty")
    try:
        payload = json.loads(payload_raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in company mappings upload: {exc}") from exc

    valid_categories, fallback_default = load_unit_categories(_unit_categories_path(request))
    mappings, default_category = normalize_company_mappings_payload(
        payload=payload,
        valid_categories=valid_categories,
        fallback_default=fallback_default,
    )
    session.wizard.company_mappings = mappings
    session.wizard.company_default_category = default_category
    _, unresolved_count = _refresh_unit_preview(session, request)
    session.wizard.generation_status = "not_started"

    manager.save_session(session)
    return CompanyMappingsUploadResponse(
        session_id=session_id,
        default_category=default_category,
        mappings_count=len(mappings),
        preview=session.wizard.mappings.unit.preview,
        unresolved_count=unresolved_count,
    )
