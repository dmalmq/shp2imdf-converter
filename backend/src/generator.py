"""Phase 4 feature generator."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

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
LEVEL_LINKED_SOURCE_TYPES = {"unit", "opening", "fixture", "detail", "kiosk", "section"}
SUPPORTED_SOURCE_FEATURE_TYPES = {
    "unit",
    "opening",
    "fixture",
    "detail",
    "amenity",
    "anchor",
    "geofence",
    "kiosk",
    "occupant",
    "relationship",
    "section",
    "facility",  # Compatibility alias for non-standard datasets.
}
CATEGORY_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config" / "categories"
DEFAULT_AMENITY_CATEGORY = "unspecified"
DEFAULT_GEOFENCE_CATEGORY = "geofence"
DEFAULT_SECTION_CATEGORY = "walkway"
DEFAULT_RELATIONSHIP_CATEGORY = "traversal"
DEFAULT_OCCUPANT_CATEGORY = "occupant"
RELATIONSHIP_DIRECTIONS = {"directed", "undirected"}
POINT_MAPPED_TYPES = {"amenity", "anchor"}
NULL_GEOMETRY_MAPPED_TYPES = {"occupant"}


def _load_category_set(filename: str) -> set[str]:
    path = CATEGORY_CONFIG_DIR / filename
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    categories = payload.get("categories", [])
    if not isinstance(categories, list):
        return set()
    return {str(item).strip().lower() for item in categories if str(item).strip()}


def _load_occupant_category_pattern() -> re.Pattern[str]:
    path = CATEGORY_CONFIG_DIR / "occupant_categories.json"
    if not path.exists():
        return re.compile(r"^[a-z0-9]+(?:[._][a-z0-9]+)*$")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return re.compile(r"^[a-z0-9]+(?:[._][a-z0-9]+)*$")
    raw_pattern = payload.get("validation_pattern")
    if not isinstance(raw_pattern, str) or not raw_pattern.strip():
        return re.compile(r"^[a-z0-9]+(?:[._][a-z0-9]+)*$")
    return re.compile(raw_pattern)


AMENITY_CATEGORIES = _load_category_set("amenity_categories.json")
GEOFENCE_CATEGORIES = _load_category_set("geofence_categories.json")
SECTION_CATEGORIES = _load_category_set("section_categories.json")
RELATIONSHIP_CATEGORIES = _load_category_set("relationship_categories.json")
OCCUPANT_CATEGORY_PATTERN = _load_occupant_category_pattern()


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


def _metadata_lookup(metadata: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for key in metadata.keys():
        if not isinstance(key, str):
            continue
        normalized = key.strip().lower()
        if normalized and normalized not in lookup:
            lookup[normalized] = key
    return lookup


def _metadata_get(metadata: dict[str, Any], lookup: dict[str, str], candidates: list[str]) -> Any:
    for candidate in candidates:
        key = lookup.get(candidate.strip().lower())
        if key is None:
            continue
        return metadata.get(key)
    return None


def _resolve_category(value: Any, valid_categories: set[str], fallback: str) -> str:
    normalized = (_normalize_text(value) or fallback).lower()
    if valid_categories and normalized not in valid_categories:
        return fallback
    return normalized


def _resolve_occupant_category(value: Any) -> str:
    normalized = (_normalize_text(value) or DEFAULT_OCCUPANT_CATEGORY).lower()
    if OCCUPANT_CATEGORY_PATTERN.match(normalized):
        return normalized
    return DEFAULT_OCCUPANT_CATEGORY


def _parse_feature_reference(value: Any) -> dict[str, str] | None:
    if isinstance(value, dict):
        identifier = _normalize_text(value.get("id"))
        feature_type = _normalize_text(value.get("feature_type"))
        if identifier and feature_type:
            return {"id": identifier, "feature_type": feature_type.lower()}
        return None

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            decoded = json.loads(text)
        except Exception:
            return None
        if isinstance(decoded, dict):
            return _parse_feature_reference(decoded)
    return None


def _reference_from_metadata(
    metadata: dict[str, Any],
    lookup: dict[str, str],
    object_candidates: list[str],
    id_candidates: list[str],
    type_candidates: list[str],
) -> dict[str, str] | None:
    parsed = _parse_feature_reference(_metadata_get(metadata, lookup, object_candidates))
    if parsed:
        return parsed

    identifier = _normalize_text(_metadata_get(metadata, lookup, id_candidates))
    feature_type = _normalize_text(_metadata_get(metadata, lookup, type_candidates))
    if not identifier or not feature_type:
        return None
    return {"id": identifier, "feature_type": feature_type.lower()}


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
        if detected_type not in LEVEL_LINKED_SOURCE_TYPES:
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
    for group in grouped.values():
        if group["short_name"] and not group["name"]:
            group["name"] = group["short_name"]
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


def _collect_provided_core_features(
    source_rows: list[dict[str, Any]],
    file_map: dict[str, Any],
    language: str,
    project: Any,
    venue_address_id: str | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    provided_buildings: list[dict[str, Any]] = []
    provided_venues: list[dict[str, Any]] = []

    for row in source_rows:
        row_properties = row.get("properties") or {}
        stem = row_properties.get("source_file")
        if not stem:
            continue
        file_info = file_map.get(stem)
        if not file_info:
            continue

        detected_type = (file_info.detected_type or "").lower()
        if detected_type not in {"building", "venue"}:
            continue

        geometry = row.get("geometry")
        if not isinstance(geometry, dict):
            continue
        geom = shape(geometry)
        if geom.is_empty:
            continue

        metadata_payload = row_properties.get("metadata")
        metadata = metadata_payload if isinstance(metadata_payload, dict) else {}
        metadata_lookup = _metadata_lookup(metadata)
        common = {
            "source_file": stem,
            "source_row_index": row_properties.get("source_row_index"),
            "source_part_index": row_properties.get("source_part_index"),
            "source_feature_ref": row_properties.get("source_feature_ref"),
            "status": "mapped",
            "issues": [],
            "metadata": metadata,
        }

        source_id = str(row.get("id") or uuid4())
        if detected_type == "building":
            fallback_name = project.venue_name if project else None
            building_name = _metadata_get(metadata, metadata_lookup, ["name", "building_name", "label"]) or fallback_name
            provided_buildings.append(
                {
                    "type": "Feature",
                    "id": source_id,
                    "feature_type": "building",
                    "geometry": None,
                    "properties": {
                        "name": wrap_labels(building_name, language=language),
                        "alt_name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["alt_name", "altname"]), language=language),
                        "category": _normalize_text(_metadata_get(metadata, metadata_lookup, ["category", "building_category", "type"]))
                        or "unspecified",
                        "restriction": _normalize_text(_metadata_get(metadata, metadata_lookup, ["restriction", "restrict"])),
                        "display_point": _display_point(geom),
                        "address_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["address_id", "addr_id"])),
                        **common,
                    },
                }
            )
            continue

        venue_name = _metadata_get(metadata, metadata_lookup, ["name", "venue_name", "label"]) or (
            project.venue_name if project else None
        )
        venue_category = _normalize_text(_metadata_get(metadata, metadata_lookup, ["category", "venue_category", "type"]))
        if not venue_category and project:
            venue_category = project.venue_category
        provided_venues.append(
            {
                "type": "Feature",
                "id": source_id,
                "feature_type": "venue",
                "geometry": geometry,
                "properties": {
                    "category": venue_category or "unspecified",
                    "restriction": _normalize_text(_metadata_get(metadata, metadata_lookup, ["restriction", "restrict"])),
                    "name": wrap_labels(venue_name, language=language),
                    "alt_name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["alt_name", "altname"]), language=language),
                    "hours": _normalize_text(_metadata_get(metadata, metadata_lookup, ["hours", "opening_hours"])),
                    "phone": _normalize_text(_metadata_get(metadata, metadata_lookup, ["phone", "telephone"])),
                    "website": _normalize_text(_metadata_get(metadata, metadata_lookup, ["website", "url"])),
                    "display_point": _display_point(geom),
                    "address_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["address_id", "addr_id"]))
                    or venue_address_id,
                    **common,
                },
            }
        )

    return provided_buildings, provided_venues


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
    provided_building_features, provided_venue_features = _collect_provided_core_features(
        source_rows=source_rows,
        file_map=file_map,
        language=language,
        project=project,
        venue_address_id=venue_address_id,
    )
    provided_primary_building_id = str(provided_building_features[0]["id"]) if provided_building_features else None

    building_uuid_by_id: dict[str, str] = {}
    for building in building_rows:
        building_uuid_by_id[building.id] = str(uuid4())

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

        level_id = str(uuid4())
        level_id_by_ordinal[ordinal] = level_id
        level_geom_by_ordinal[ordinal] = merged

        linked_buildings: list[str]
        if provided_primary_building_id:
            linked_buildings = [provided_primary_building_id]
        else:
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
    level_stems = {item.stem for item in session.files if (item.detected_type or "").lower() in LEVEL_LINKED_SOURCE_TYPES}

    footprint_targets: list[tuple[str, str, set[str]]] = []
    if provided_primary_building_id:
        footprint_targets.append(("provided-primary", provided_primary_building_id, level_stems))
    else:
        for building in building_rows:
            footprint_targets.append((building.id, building_uuid_by_id[building.id], set(building.file_stems)))

    for building_key, building_uuid, building_stems in footprint_targets:
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
            fp_buffer = max(float(session.wizard.footprint.footprint_buffer_m), 0.0) * DEGREES_PER_METER
            if fp_buffer > 0:
                merged = merged.buffer(fp_buffer)

            category = "ground" if ordinal == 0 else ("aerial" if ordinal > 0 else "subterranean")
            footprint_id = str(uuid4())
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
            first_geom_by_building.setdefault(building_key, merged)
            if ordinal == 0:
                ground_geom_by_building[building_key] = merged

    building_features: list[dict[str, Any]]
    if provided_building_features:
        building_features = provided_building_features
    else:
        building_features = []
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

    venue_features: list[dict[str, Any]] = [item for item in provided_venue_features]
    if project and not venue_features:
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
            venue_features.append(
                {
                    "type": "Feature",
                    "id": str(uuid4()),
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
            )

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
        if feature_type not in SUPPORTED_SOURCE_FEATURE_TYPES:
            continue

        geometry = row.get("geometry")
        if not isinstance(geometry, dict):
            continue
        geom = shape(geometry)
        if geom.is_empty:
            continue

        ordinal = file_info.detected_level
        level_id = level_id_by_ordinal.get(ordinal) if ordinal is not None else None
        if feature_type in LEVEL_LINKED_SOURCE_TYPES and not level_id:
            continue

        metadata_payload = row_properties.get("metadata")
        metadata = metadata_payload if isinstance(metadata_payload, dict) else {}
        metadata_lookup = _metadata_lookup(metadata)
        common = {
            "source_file": stem,
            "source_row_index": row_properties.get("source_row_index"),
            "source_part_index": row_properties.get("source_part_index"),
            "source_feature_ref": row_properties.get("source_feature_ref"),
            "status": "mapped",
            "issues": [],
            "metadata": metadata,
        }

        output_geometry: dict[str, Any] | None = geometry
        if feature_type in POINT_MAPPED_TYPES:
            point_geom = geom if geom.geom_type == "Point" else geom.representative_point()
            output_geometry = mapping(point_geom)
        elif feature_type in NULL_GEOMETRY_MAPPED_TYPES:
            output_geometry = None

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
        elif feature_type == "detail":
            new_properties = {
                "level_id": level_id,
                **common,
            }
        elif feature_type == "amenity":
            new_properties = {
                "category": _resolve_category(
                    _metadata_get(metadata, metadata_lookup, ["category", "amenity_category", "type"]),
                    AMENITY_CATEGORIES,
                    DEFAULT_AMENITY_CATEGORY,
                ),
                "unit_ids": _parse_list(_metadata_get(metadata, metadata_lookup, ["unit_ids", "unit_id", "unitids"])) or [],
                "accessibility": _parse_list(_metadata_get(metadata, metadata_lookup, ["accessibility", "accessible"])),
                "name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["name", "amenity_name", "label"]), language=language),
                "alt_name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["alt_name", "altname"]), language=language),
                "hours": _normalize_text(_metadata_get(metadata, metadata_lookup, ["hours", "opening_hours"])),
                "phone": _normalize_text(_metadata_get(metadata, metadata_lookup, ["phone", "telephone"])),
                "website": _normalize_text(_metadata_get(metadata, metadata_lookup, ["website", "url"])),
                "address_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["address_id", "addr_id"])),
                **common,
            }
        elif feature_type == "anchor":
            new_properties = {
                "unit_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["unit_id", "unitid"])),
                "address_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["address_id", "addr_id"])),
                **common,
            }
        elif feature_type == "geofence":
            feature_ids = _parse_list(_metadata_get(metadata, metadata_lookup, ["feature_ids", "feature_id", "features"])) or []
            level_ids = _parse_list(_metadata_get(metadata, metadata_lookup, ["level_ids", "level_id", "levels"]))
            building_ids = _parse_list(_metadata_get(metadata, metadata_lookup, ["building_ids", "building_id", "buildings"]))
            new_properties = {
                "category": _resolve_category(
                    _metadata_get(metadata, metadata_lookup, ["category", "geofence_category", "type"]),
                    GEOFENCE_CATEGORIES,
                    DEFAULT_GEOFENCE_CATEGORY,
                ),
                "feature_ids": feature_ids,
                **common,
            }
            if level_ids:
                new_properties["level_ids"] = level_ids
            if building_ids:
                new_properties["building_ids"] = building_ids
        elif feature_type == "kiosk":
            new_properties = {
                "name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["name", "kiosk_name", "label"]), language=language),
                "alt_name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["alt_name", "altname"]), language=language),
                "hours": _normalize_text(_metadata_get(metadata, metadata_lookup, ["hours", "opening_hours"])),
                "phone": _normalize_text(_metadata_get(metadata, metadata_lookup, ["phone", "telephone"])),
                "website": _normalize_text(_metadata_get(metadata, metadata_lookup, ["website", "url"])),
                "anchor_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["anchor_id", "anchorid"])),
                "level_id": level_id,
                **common,
            }
        elif feature_type == "occupant":
            new_properties = {
                "category": _resolve_occupant_category(
                    _metadata_get(metadata, metadata_lookup, ["category", "occupant_category", "type"])
                ),
                "name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["name", "occupant_name", "label"]), language=language),
                "hours": _normalize_text(_metadata_get(metadata, metadata_lookup, ["hours", "opening_hours"])),
                "phone": _normalize_text(_metadata_get(metadata, metadata_lookup, ["phone", "telephone"])),
                "website": _normalize_text(_metadata_get(metadata, metadata_lookup, ["website", "url"])),
                "anchor_id": _normalize_text(_metadata_get(metadata, metadata_lookup, ["anchor_id", "anchorid"])),
                **common,
            }
        elif feature_type == "relationship":
            new_properties = {
                "category": _resolve_category(
                    _metadata_get(metadata, metadata_lookup, ["category", "relationship_category", "type"]),
                    RELATIONSHIP_CATEGORIES,
                    DEFAULT_RELATIONSHIP_CATEGORY,
                ),
                "direction": (
                    direction
                    if (direction := (_normalize_text(_metadata_get(metadata, metadata_lookup, ["direction"])) or "undirected").lower())
                    in RELATIONSHIP_DIRECTIONS
                    else "undirected"
                ),
                "origin": _reference_from_metadata(
                    metadata,
                    metadata_lookup,
                    object_candidates=["origin", "source", "from"],
                    id_candidates=["origin_id", "source_id", "from_id"],
                    type_candidates=["origin_type", "source_type", "from_type"],
                ),
                "destination": _reference_from_metadata(
                    metadata,
                    metadata_lookup,
                    object_candidates=["destination", "target", "to"],
                    id_candidates=["destination_id", "target_id", "to_id"],
                    type_candidates=["destination_type", "target_type", "to_type"],
                ),
                **common,
            }
        elif feature_type == "section":
            new_properties = {
                "category": _resolve_category(
                    _metadata_get(metadata, metadata_lookup, ["category", "section_category", "type"]),
                    SECTION_CATEGORIES,
                    DEFAULT_SECTION_CATEGORY,
                ),
                "name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["name", "section_name", "label"]), language=language),
                "alt_name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["alt_name", "altname"]), language=language),
                "restriction": _normalize_text(_metadata_get(metadata, metadata_lookup, ["restriction", "restrict"])),
                "level_id": level_id,
                **common,
            }
        else:
            new_properties = {
                "category": _normalize_text(_metadata_get(metadata, metadata_lookup, ["category", "type"])) or "unspecified",
                "name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["name", "label"]), language=language),
                "alt_name": wrap_labels(_metadata_get(metadata, metadata_lookup, ["alt_name", "altname"]), language=language),
                "level_id": level_id,
                **common,
            }

        mapped_features.append(
            {
                "type": "Feature",
                "id": str(row.get("id") or uuid4()),
                "feature_type": feature_type,
                "geometry": output_geometry,
                "properties": new_properties,
            }
        )

    final_features: list[dict[str, Any]] = []
    final_features.extend(addresses)
    final_features.extend(venue_features)
    final_features.extend(building_features)
    final_features.extend(footprint_features)
    final_features.extend(level_features)
    final_features.extend(mapped_features)
    return {"type": "FeatureCollection", "features": final_features}
