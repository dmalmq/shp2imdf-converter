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
    normalize_unit_category_overrides,
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


def _pick_preferred_column(
    candidates: list[str],
    used: set[str],
    exact_keys: list[str],
    contains_keys: list[str],
) -> str | None:
    lookup = {item.upper(): item for item in candidates}
    for key in exact_keys:
        value = lookup.get(key.upper())
        if value and value not in used:
            return value

    scored: list[tuple[int, str]] = []
    for column in candidates:
        if column in used:
            continue
        upper = column.upper()
        score = 0
        for key in contains_keys:
            if key.upper() in upper:
                score += 1
        if score:
            scored.append((score, column))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[0][1]


def _set_default_unit_mapping_columns(session: SessionRecord) -> None:
    mapping = session.wizard.mappings.unit
    if (
        mapping.code_column
        and mapping.name_column
        and mapping.alt_name_column
        and mapping.restriction_column
        and mapping.accessibility_column
    ):
        return

    candidates = detect_candidate_columns(session.files, feature_type="unit")
    if not candidates:
        return

    used: set[str] = {
        value
        for value in [
            mapping.code_column,
            mapping.name_column,
            mapping.alt_name_column,
            mapping.restriction_column,
            mapping.accessibility_column,
        ]
        if value
    }

    if not mapping.code_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["CATEGORY", "COMPANY_CO", "COMPANY_CODE", "TYPE", "CAT"],
            contains_keys=["CATEGORY", "COMPANY", "TYPE", "CAT"],
        ) or candidates[0]
        mapping.code_column = selected
        used.add(selected)

    if not mapping.name_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["NAME", "UNIT_NAME", "SHOP_NAME", "TENANT_NAM", "TENANT_NAME", "LABEL", "TITLE"],
            contains_keys=["NAME", "TITLE", "LABEL"],
        )
        if selected:
            mapping.name_column = selected
            used.add(selected)

    if not mapping.alt_name_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["ALT_NAME", "ALTNAME", "NAME_EN", "EN_NAME", "NAME_KANA"],
            contains_keys=["ALT", "EN_NAME", "KANA"],
        )
        if selected:
            mapping.alt_name_column = selected
            used.add(selected)

    if not mapping.restriction_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["RESTRICTION", "ACCESS_CTRL", "ACCESS_CON", "PRIVATE", "SECURITY"],
            contains_keys=["RESTRICT", "ACCESS_CTRL", "PRIVATE", "SECURITY"],
        )
        if selected:
            mapping.restriction_column = selected
            used.add(selected)

    if not mapping.accessibility_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["ACCESSIBILITY", "ACCESSIBLE", "BARRIER_FR", "BARRIER", "WHEELCHAI", "WHEELCHAIR", "ADA"],
            contains_keys=["ACCESS", "BARRIER", "WHEEL", "ADA"],
        )
        if selected:
            mapping.accessibility_column = selected
            used.add(selected)


def _set_default_opening_mapping_columns(session: SessionRecord) -> None:
    mapping = session.wizard.mappings.opening
    candidates = detect_candidate_columns(session.files, feature_type="opening")
    if not candidates:
        return

    used: set[str] = {
        value
        for value in [
            mapping.category_column,
            mapping.accessibility_column,
            mapping.access_control_column,
            mapping.door_automatic_column,
            mapping.door_material_column,
            mapping.door_type_column,
            mapping.name_column,
        ]
        if value
    }

    if not mapping.category_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["CATEGORY", "TYPE", "OPENING_TYPE", "CLASS"],
            contains_keys=["CATEGORY", "OPENING", "TYPE", "CLASS"],
        )
        if selected:
            mapping.category_column = selected
            used.add(selected)

    if not mapping.name_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["NAME", "OPENING_NAME", "LABEL", "TITLE"],
            contains_keys=["NAME", "LABEL", "TITLE"],
        )
        if selected:
            mapping.name_column = selected
            used.add(selected)

    if not mapping.accessibility_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["ACCESSIBILITY", "ACCESSIBLE", "BARRIER_FR", "BARRIER", "WHEELCHAIR", "ADA"],
            contains_keys=["ACCESS", "BARRIER", "WHEEL", "ADA"],
        )
        if selected:
            mapping.accessibility_column = selected
            used.add(selected)

    if not mapping.access_control_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["ACCESS_CONTROL", "ACCESS_CTRL", "SECURITY", "RESTRICTION"],
            contains_keys=["ACCESS_CTRL", "SECURITY", "RESTRICT", "CONTROL"],
        )
        if selected:
            mapping.access_control_column = selected
            used.add(selected)

    if not mapping.door_automatic_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["DOOR_AUTO", "AUTOMATIC", "AUTO_DOOR", "DOOR_AUTOM"],
            contains_keys=["AUTOMATIC", "AUTO"],
        )
        if selected:
            mapping.door_automatic_column = selected
            used.add(selected)

    if not mapping.door_material_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["DOOR_MATER", "DOOR_MTRL", "MATERIAL"],
            contains_keys=["MATERIAL", "MTRL"],
        )
        if selected:
            mapping.door_material_column = selected
            used.add(selected)

    if not mapping.door_type_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["DOOR_TYPE", "OPENING_TYPE"],
            contains_keys=["DOOR_TYPE", "OPENING_TYPE"],
        )
        if selected:
            mapping.door_type_column = selected
            used.add(selected)


def _set_default_fixture_mapping_columns(session: SessionRecord) -> None:
    mapping = session.wizard.mappings.fixture
    candidates = detect_candidate_columns(session.files, feature_type="fixture")
    if not candidates:
        return

    used: set[str] = {
        value
        for value in [
            mapping.name_column,
            mapping.alt_name_column,
            mapping.category_column,
        ]
        if value
    }

    if not mapping.category_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["CATEGORY", "TYPE", "FIXTURE_CA", "CLASS"],
            contains_keys=["CATEGORY", "FIXTURE", "TYPE", "CLASS"],
        )
        if selected:
            mapping.category_column = selected
            used.add(selected)

    if not mapping.name_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["NAME", "FIXTURE_NAME", "LABEL", "TITLE"],
            contains_keys=["NAME", "LABEL", "TITLE"],
        )
        if selected:
            mapping.name_column = selected
            used.add(selected)

    if not mapping.alt_name_column:
        selected = _pick_preferred_column(
            candidates,
            used,
            exact_keys=["ALT_NAME", "ALTNAME", "NAME_EN", "EN_NAME", "NAME_KANA"],
            contains_keys=["ALT", "EN_NAME", "KANA"],
        )
        if selected:
            mapping.alt_name_column = selected
            used.add(selected)


def _set_default_mapping_columns(session: SessionRecord) -> None:
    _set_default_unit_mapping_columns(session)
    _set_default_opening_mapping_columns(session)
    _set_default_fixture_mapping_columns(session)


def _refresh_unit_preview(session: SessionRecord, request: Request) -> tuple[int, int]:
    valid_categories, config_default = load_unit_categories(_unit_categories_path(request))
    default_category = session.wizard.company_default_category or config_default
    if default_category not in valid_categories:
        default_category = config_default

    session.wizard.mappings.unit.available_categories = sorted(valid_categories)
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
    _set_default_mapping_columns(session)
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
    if payload.unit_category_overrides:
        valid_categories, _ = load_unit_categories(_unit_categories_path(request))
        overrides = normalize_unit_category_overrides(payload.unit_category_overrides, valid_categories)
        session.wizard.company_mappings.update(overrides)

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
