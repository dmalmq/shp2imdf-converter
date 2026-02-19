"""Phase 4 feature generator."""

from __future__ import annotations

import copy
import re
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from backend.src.mapper import load_unit_categories, resolve_unit_category, wrap_labels
from backend.src.schemas import BuildingWizardState, LevelWizardItem, SessionRecord
from backend.src.wizard import build_address_feature, seed_wizard_state


DEGREES_PER_METER = 1 / 111_320
OPENING_CATEGORIES = {
    "automobile",
    "bicycle",
    "pedestrian",
    "emergencyexit",
    "pedestrian.principal",
    "pedestrian.transit",
    "service",
}
GENERATOR_NAMESPACE = uuid5(NAMESPACE_URL, "shp2imdf-converter/generator")


def _stable_id(session_id: str, key: str) -> str:
    return str(uuid5(GENERATOR_NAMESPACE, f"{session_id}:{key}"))


def _default_short_name(ordinal: int) -> str:
    if ordinal == 0:
        return "GH"
    if ordinal > 0:
        return f"{ordinal}F"
    return f"B{abs(ordinal)}"


def _display_point(geom: Any) -> dict[str, Any] | None:
    if geom is None or geom.is_empty:
        return None
    point = geom.representative_point()
    return {"type": "Point", "coordinates": [point.x, point.y]}


def _parse_list(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None
    text = str(value).strip()
    if not text:
        return None
    parts = [token.strip() for token in re.split(r"[;,|]", text) if token.strip()]
    return parts or [text]


def _parse_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if not text:
        return None
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return None


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _clean_feature(feature: dict[str, Any]) -> dict[str, Any]:
    copied = copy.deepcopy(feature)
    properties = copied.get("properties")
    if isinstance(properties, dict):
        copied["properties"] = {k: v for k, v in properties.items() if not str(k).startswith("_")}
    return copied


def _source_feature_rows(session: SessionRecord) -> list[dict[str, Any]]:
    collection = session.source_feature_collection or session.feature_collection
    rows = collection.get("features", [])
    if not isinstance(rows, list):
        return []
    return rows


def _level_items_from_files(session: SessionRecord) -> list[LevelWizardItem]:
    items: list[LevelWizardItem] = []
    for file in session.files:
        detected_type = (file.detected_type or "").lower()
        if detected_type not in {"unit", "opening", "fixture", "detail"}:
            continue
        items.append(
            LevelWizardItem(
                stem=file.stem,
                detected_type=file.detected_type,
                ordinal=file.detected_level,
                name=file.level_name,
                short_name=file.short_name,
                outdoor=file.outdoor,
                category=file.level_category,
            )
        )
    return items


def _collect_level_groups(session: SessionRecord) -> dict[int, dict[str, Any]]:
    level_items = session.wizard.levels.items or _level_items_from_files(session)
    grouped: dict[int, dict[str, Any]] = {}
    for item in level_items:
        if item.ordinal is None:
            continue
        group = grouped.setdefault(
            item.ordinal,
            {
                "ordinal": item.ordinal,
                "name": None,
                "short_name": None,
                "category": "unspecified",
                "outdoor": False,
                "stems": set(),
            },
        )
        if item.name and not group["name"]:
            group["name"] = item.name
        if item.short_name and not group["short_name"]:
            group["short_name"] = item.short_name
        if item.category and item.category != "unspecified":
            group["category"] = item.category
        if item.outdoor:
            group["outdoor"] = True
        group["stems"].add(item.stem)
    return grouped


def _collect_address_features(session: SessionRecord) -> tuple[list[dict[str, Any]], str | None]:
    project = session.wizard.project
    venue_address_feature = session.wizard.venue_address_feature
    if project and venue_address_feature is None:
        venue_address_feature = build_address_feature(project.address, fallback_name=project.venue_name)

    addresses: list[dict[str, Any]] = []
    venue_address_id: str | None = None
    if isinstance(venue_address_feature, dict):
        cleaned = _clean_feature(venue_address_feature)
        addresses.append(cleaned)
        venue_address_id = str(cleaned.get("id")) if cleaned.get("id") else None

    known_ids = {str(item.get("id")) for item in addresses if item.get("id")}
    for feature in session.wizard.building_address_features:
        if not isinstance(feature, dict):
            continue
        cleaned = _clean_feature(feature)
        address_id = str(cleaned.get("id")) if cleaned.get("id") else None
        if address_id and address_id in known_ids:
            continue
        if address_id:
            known_ids.add(address_id)
        addresses.append(cleaned)

    return addresses, venue_address_id


def _unit_geometries_by_stem(source_rows: list[dict[str, Any]], file_map: dict[str, Any]) -> dict[str, list[Any]]:
    geoms_by_stem: dict[str, list[Any]] = {}
    for row in source_rows:
        properties = row.get("properties") or {}
        stem = properties.get("source_file")
        if not stem or stem not in file_map:
            continue
        if (file_map[stem].detected_type or "").lower() != "unit":
            continue
        geometry = row.get("geometry")
        if not isinstance(geometry, dict):
            continue
        geom = shape(geometry)
        if geom.is_empty:
            continue
        geoms_by_stem.setdefault(stem, []).append(geom)
    return geoms_by_stem


def generate_feature_collection(session: SessionRecord, unit_categories_path: str) -> dict[str, Any]:
    seed_wizard_state(session)
    source_rows = _source_feature_rows(session)
    file_map = {item.stem: item for item in session.files}
    valid_unit_categories, fallback_unit_category = load_unit_categories(unit_categories_path)

    project = session.wizard.project
    language = project.language.strip() if project and project.language.strip() else "en"
    building_rows = session.wizard.buildings or [
        BuildingWizardState(id="building-1", file_stems=[item.stem for item in session.files])
    ]
    level_groups = _collect_level_groups(session)
    unit_geoms_by_stem = _unit_geometries_by_stem(source_rows, file_map)

    addresses, venue_address_id = _collect_address_features(session)

    building_uuid_by_id: dict[str, str] = {}
    for building in building_rows:
        building_uuid_by_id[building.id] = _stable_id(session.session_id, f"building:{building.id}")

    level_features: list[dict[str, Any]] = []
    level_id_by_ordinal: dict[int, str] = {}
    level_geom_by_ordinal: dict[int, Any] = {}
    level_building_ids: dict[int, list[str]] = {}
    for ordinal, group in sorted(level_groups.items(), key=lambda item: item[0]):
        stems = set(group["stems"])
        polygon_geoms: list[Any] = []
        for stem in stems:
            polygon_geoms.extend(unit_geoms_by_stem.get(stem, []))

        if not polygon_geoms:
            for row in source_rows:
                properties = row.get("properties") or {}
                if properties.get("source_file") not in stems:
                    continue
                geometry = row.get("geometry")
                if not isinstance(geometry, dict):
                    continue
                geom = shape(geometry)
                if geom.is_empty:
                    continue
                if geom.geom_type in {"Polygon", "MultiPolygon"}:
                    polygon_geoms.append(geom)

        if not polygon_geoms:
            continue

        merged = unary_union(polygon_geoms)
        if merged.is_empty:
            continue

        level_id = _stable_id(session.session_id, f"level:{ordinal}")
        level_id_by_ordinal[ordinal] = level_id
        level_geom_by_ordinal[ordinal] = merged

        linked_buildings = []
        for building in building_rows:
            if stems.intersection(set(building.file_stems)):
                linked_buildings.append(building_uuid_by_id[building.id])
        linked_buildings = sorted(set(linked_buildings))
        if not linked_buildings and building_rows:
            linked_buildings = [building_uuid_by_id[building_rows[0].id]]
        level_building_ids[ordinal] = linked_buildings

        level_name = group["name"] or f"Level {ordinal}"
        level_short_name = group["short_name"] or _default_short_name(ordinal)
        level_features.append(
            {
                "type": "Feature",
                "id": level_id,
                "feature_type": "level",
                "geometry": mapping(merged),
                "properties": {
                    "category": group["category"] or "unspecified",
                    "restriction": None,
                    "outdoor": bool(group["outdoor"]),
                    "ordinal": ordinal,
                    "name": wrap_labels(level_name, language=language) or {language: level_name},
                    "short_name": wrap_labels(level_short_name, language=language) or {language: level_short_name},
                    "display_point": _display_point(merged),
                    "address_id": None,
                    "building_ids": linked_buildings,
                    "status": "mapped",
                    "issues": [],
                    "source_files": sorted(stems),
                },
            }
        )

    footprint_features: list[dict[str, Any]] = []
    ground_geom_by_building: dict[str, Any] = {}
    first_geom_by_building: dict[str, Any] = {}
    for building in building_rows:
        building_uuid = building_uuid_by_id[building.id]
        building_stems = set(building.file_stems)
        for ordinal, level_geom in sorted(level_geom_by_ordinal.items(), key=lambda item: item[0]):
            geometries = []
            for stem in building_stems:
                file_info = file_map.get(stem)
                if not file_info:
                    continue
                if (file_info.detected_type or "").lower() != "unit":
                    continue
                if file_info.detected_level != ordinal:
                    continue
                geometries.extend(unit_geoms_by_stem.get(stem, []))
            if not geometries and building_uuid in level_building_ids.get(ordinal, []):
                geometries = [level_geom]
            if not geometries:
                continue
            merged = unary_union(geometries)
            if merged.is_empty:
                continue

            category = "ground" if ordinal == 0 else ("aerial" if ordinal > 0 else "subterranean")
            footprint_id = _stable_id(session.session_id, f"footprint:{building.id}:{ordinal}")
            footprint_features.append(
                {
                    "type": "Feature",
                    "id": footprint_id,
                    "feature_type": "footprint",
                    "geometry": mapping(merged),
                    "properties": {
                        "category": category,
                        "name": None,
                        "building_ids": [building_uuid],
                        "status": "mapped",
                        "issues": [],
                        "ordinal": ordinal,
                    },
                }
            )
            first_geom_by_building.setdefault(building.id, merged)
            if ordinal == 0:
                ground_geom_by_building[building.id] = merged

    building_features: list[dict[str, Any]] = []
    for building in building_rows:
        building_uuid = building_uuid_by_id[building.id]
        anchor_geom = ground_geom_by_building.get(building.id) or first_geom_by_building.get(building.id)
        fallback_name = project.venue_name if project else None
        resolved_name = building.name or fallback_name
        building_features.append(
            {
                "type": "Feature",
                "id": building_uuid,
                "feature_type": "building",
                "geometry": None,
                "properties": {
                    "name": wrap_labels(resolved_name, language=language),
                    "alt_name": None,
                    "category": building.category or "unspecified",
                    "restriction": building.restriction,
                    "display_point": _display_point(anchor_geom) if anchor_geom is not None else None,
                    "address_id": building.address_feature_id,
                    "status": "mapped",
                    "issues": [],
                },
            }
        )

    venue_feature: dict[str, Any] | None = None
    if project:
        venue_geometries = []
        for footprint in footprint_features:
            geometry = footprint.get("geometry")
            if not isinstance(geometry, dict):
                continue
            venue_geometries.append(shape(geometry))
        if not venue_geometries:
            venue_geometries = [geom for geom in level_geom_by_ordinal.values() if geom is not None and not geom.is_empty]
        if not venue_geometries:
            for geoms in unit_geoms_by_stem.values():
                for geom in geoms:
                    if geom is not None and not geom.is_empty:
                        venue_geometries.append(geom)

        if venue_geometries:
            merged_venue = unary_union(venue_geometries)
            venue_buffer = max(float(session.wizard.footprint.venue_buffer_m), 0.0) * DEGREES_PER_METER
            if venue_buffer > 0:
                merged_venue = merged_venue.buffer(venue_buffer)
            venue_feature = {
                "type": "Feature",
                "id": _stable_id(session.session_id, "venue"),
                "feature_type": "venue",
                "geometry": mapping(merged_venue),
                "properties": {
                    "category": project.venue_category,
                    "restriction": project.venue_restriction,
                    "name": wrap_labels(project.venue_name, language=language),
                    "alt_name": None,
                    "hours": project.venue_hours,
                    "phone": project.venue_phone,
                    "website": project.venue_website,
                    "display_point": _display_point(merged_venue),
                    "address_id": venue_address_id,
                    "status": "mapped",
                    "issues": [],
                },
            }

    company_mappings = session.wizard.company_mappings
    default_unit_category = session.wizard.company_default_category or fallback_unit_category
    if default_unit_category not in valid_unit_categories:
        default_unit_category = fallback_unit_category
    mapping_config = session.wizard.mappings

    mapped_features: list[dict[str, Any]] = []
    for row in source_rows:
        row_properties = row.get("properties") or {}
        stem = row_properties.get("source_file")
        if not stem:
            continue
        file_info = file_map.get(stem)
        if not file_info:
            continue

        feature_type = (file_info.detected_type or "").lower()
        if feature_type not in {"unit", "opening", "fixture", "detail"}:
            continue

        geometry = row.get("geometry")
        if not isinstance(geometry, dict):
            continue
        geom = shape(geometry)
        if geom.is_empty:
            continue

        ordinal = file_info.detected_level
        if ordinal is None:
            continue
        level_id = level_id_by_ordinal.get(ordinal)
        if not level_id:
            continue

        metadata = row_properties.get("metadata") or {}
        common = {
            "source_file": stem,
            "status": "mapped",
            "issues": [],
            "metadata": metadata,
        }

        if feature_type == "unit":
            code_column = mapping_config.unit.code_column
            raw_code = metadata.get(code_column) if code_column else None
            category, _ = resolve_unit_category(
                raw_code=raw_code,
                company_mappings=company_mappings,
                valid_categories=valid_unit_categories,
                default_category=default_unit_category,
            )
            new_properties = {
                "category": category,
                "restriction": _normalize_text(metadata.get(mapping_config.unit.restriction_column))
                if mapping_config.unit.restriction_column
                else None,
                "accessibility": _parse_list(metadata.get(mapping_config.unit.accessibility_column))
                if mapping_config.unit.accessibility_column
                else None,
                "name": wrap_labels(metadata.get(mapping_config.unit.name_column), language=language)
                if mapping_config.unit.name_column
                else None,
                "alt_name": wrap_labels(metadata.get(mapping_config.unit.alt_name_column), language=language)
                if mapping_config.unit.alt_name_column
                else None,
                "level_id": level_id,
                "display_point": _display_point(geom),
                **common,
            }
        elif feature_type == "opening":
            category = "pedestrian"
            if mapping_config.opening.category_column:
                raw_value = _normalize_text(metadata.get(mapping_config.opening.category_column))
                if raw_value and raw_value.lower() in OPENING_CATEGORIES:
                    category = raw_value.lower()
            door_payload = {
                "automatic": _parse_bool(metadata.get(mapping_config.opening.door_automatic_column))
                if mapping_config.opening.door_automatic_column
                else None,
                "material": _normalize_text(metadata.get(mapping_config.opening.door_material_column))
                if mapping_config.opening.door_material_column
                else None,
                "type": _normalize_text(metadata.get(mapping_config.opening.door_type_column))
                if mapping_config.opening.door_type_column
                else None,
            }
            if not any(item is not None for item in door_payload.values()):
                door_payload = None
            new_properties = {
                "category": category,
                "accessibility": _parse_list(metadata.get(mapping_config.opening.accessibility_column))
                if mapping_config.opening.accessibility_column
                else None,
                "access_control": _parse_list(metadata.get(mapping_config.opening.access_control_column))
                if mapping_config.opening.access_control_column
                else None,
                "door": door_payload,
                "name": wrap_labels(metadata.get(mapping_config.opening.name_column), language=language)
                if mapping_config.opening.name_column
                else None,
                "alt_name": None,
                "display_point": _display_point(geom),
                "level_id": level_id,
                **common,
            }
        elif feature_type == "fixture":
            fixture_category = "unspecified"
            if mapping_config.fixture.category_column:
                fixture_category = _normalize_text(metadata.get(mapping_config.fixture.category_column)) or "unspecified"
            new_properties = {
                "category": fixture_category.lower(),
                "name": wrap_labels(metadata.get(mapping_config.fixture.name_column), language=language)
                if mapping_config.fixture.name_column
                else None,
                "alt_name": wrap_labels(metadata.get(mapping_config.fixture.alt_name_column), language=language)
                if mapping_config.fixture.alt_name_column
                else None,
                "anchor_id": None,
                "level_id": level_id,
                "display_point": _display_point(geom),
                **common,
            }
        else:
            new_properties = {
                "level_id": level_id,
                **common,
            }

        mapped_features.append(
            {
                "type": "Feature",
                "id": str(row.get("id") or uuid4()),
                "feature_type": feature_type,
                "geometry": geometry,
                "properties": new_properties,
            }
        )

    final_features: list[dict[str, Any]] = []
    final_features.extend(addresses)
    if venue_feature:
        final_features.append(venue_feature)
    final_features.extend(building_features)
    final_features.extend(footprint_features)
    final_features.extend(level_features)
    final_features.extend(mapped_features)
    return {"type": "FeatureCollection", "features": final_features}
