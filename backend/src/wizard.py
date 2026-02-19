"""Wizard state helpers for Phase 3."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from backend.src.mapper import wrap_labels
from backend.src.schemas import (
    AddressInput,
    BuildingWizardState,
    LevelWizardItem,
    ProjectWizardState,
    SessionRecord,
)


LEVEL_FILE_TYPES = {"unit", "opening", "fixture", "detail"}


def _default_short_name(ordinal: int | None) -> str | None:
    if ordinal is None:
        return None
    if ordinal == 0:
        return "GF"
    if ordinal > 0:
        return f"{ordinal}F"
    return f"B{abs(ordinal)}"


def seed_wizard_state(session: SessionRecord) -> None:
    if not session.wizard.buildings:
        session.wizard.buildings = [
            BuildingWizardState(
                id="building-1",
                file_stems=[item.stem for item in session.files],
            )
        ]

    if not session.wizard.levels.items:
        level_items: list[LevelWizardItem] = []
        for file in session.files:
            detected_type = (file.detected_type or "").lower()
            if detected_type not in LEVEL_FILE_TYPES:
                continue
            level_items.append(
                LevelWizardItem(
                    stem=file.stem,
                    detected_type=file.detected_type,
                    ordinal=file.detected_level,
                    name=file.level_name,
                    short_name=file.short_name or _default_short_name(file.detected_level),
                    outdoor=file.outdoor,
                    category=file.level_category,
                )
            )
        session.wizard.levels.items = level_items


def build_address_feature(address: AddressInput, fallback_name: str | None = None) -> dict[str, Any]:
    line = (address.address or "").strip() or (fallback_name or "").strip()
    return {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": "address",
        "geometry": None,
        "properties": {
            "address": line,
            "unit": address.unit,
            "locality": address.locality,
            "province": address.province,
            "country": address.country,
            "postal_code": address.postal_code,
            "postal_code_ext": address.postal_code_ext,
            "postal_code_vanity": address.postal_code_vanity,
            "status": "mapped",
            "issues": [],
            "_phase3_generated": True,
        },
    }


def build_building_feature(
    building: BuildingWizardState,
    project: ProjectWizardState | None,
) -> dict[str, Any]:
    language = project.language if project else "en"
    fallback_name = project.venue_name if project else None
    building_name = building.name or fallback_name
    return {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": "building",
        "geometry": None,
        "properties": {
            "name": wrap_labels(building_name, language=language),
            "alt_name": None,
            "category": building.category or "unspecified",
            "restriction": building.restriction,
            "display_point": None,
            "address_id": building.address_feature_id,
            "status": "mapped",
            "issues": [],
            "_phase3_generated": True,
            "_wizard_building_id": building.id,
        },
    }

