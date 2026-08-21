"""Import shapefiles that already use an IMDF-like attribute schema."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import json
import re
from typing import Any
from uuid import UUID, uuid4

from shapely import make_valid, union_all
from shapely.errors import GEOSException
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from backend.src.importer import ImportArtifacts, import_file_blobs


CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
LEVEL_LINKED_TYPES = {"unit", "opening", "fixture", "detail", "kiosk", "section", "floor_connect"}
POLYGON_TYPES = {"venue", "level", "unit", "fixture", "section", "kiosk"}
LINE_TYPES = {"opening", "detail"}
POINT_TYPES = {"amenity", "anchor", "floor_connect"}
NULL_GEOM_TYPES = {"building", "address", "occupant"}
ODC_LAYER_ALIASES = {
    "site": "venue",
    "building": "building",
    "floor": "level",
    "space": "unit",
    "fixture": "fixture",
    "opening": "opening",
    "drawing": "detail",
    "segment": "section",
    "facility": "amenity",
    "occupant": "occupant",
    "unit": "unit",
}
ODC_CONNECT_ALIASES = {("floor", "connect"): "floor_connect"}
ODC_IGNORED_LAYER_SUFFIXES = {("build", "connect")}
# Facility_Merge (地図記号表示点) is a station-wide point layer that the ODC
# export splits back into per-floor Facility layers.
ODC_SUFFIX_ALIASES = {("facility", "merge"): "amenity"}


def _metadata_lookup(metadata: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for key in metadata:
        normalized = str(key).strip().lower()
        if normalized and normalized not in lookup:
            lookup[normalized] = str(key)
    return lookup


def _metadata_get(metadata: dict[str, Any], candidates: list[str]) -> Any:
    lookup = _metadata_lookup(metadata)
    for candidate in candidates:
        key = lookup.get(candidate.strip().lower())
        if key is not None:
            return metadata.get(key)
    return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int_value(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        numeric = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return int(round(numeric))


def _bool_value(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y", "indoor"}:
        return True
    if text in {"0", "false", "f", "no", "n", "outdoor"}:
        return False
    if text == "2":
        return True
    return None


def _feature_id(value: Any) -> str:
    text = _text(value)
    if text:
        try:
            return str(UUID(text))
        except ValueError:
            pass
    return str(uuid4())


def _label(value: Any, language: str = "en") -> dict[str, str] | None:
    text = _text(value)
    if not text:
        return None
    return {language: text}


def _label_text(value: Any) -> str | None:
    if isinstance(value, dict):
        for item in value.values():
            text = _text(item)
            if text:
                return text
        return None
    return _text(value)


def _level_merge_key(level_name: Any, short_name: Any, ordinal: int) -> str:
    text = _text(level_name) or _text(short_name)
    if text:
        return re.sub(r"\s+", " ", text).casefold()
    return f"ordinal:{ordinal}"


def _parse_list(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None
    text = str(value).strip()
    if not text:
        return None
    if text.startswith("["):
        try:
            decoded = json.loads(text)
            if isinstance(decoded, list):
                return [str(item).strip() for item in decoded if str(item).strip()] or None
        except Exception:
            pass
    parts = [item.strip() for item in re.split(r"[;,|]", text) if item.strip()]
    return parts or [text]


def _category_value(value: Any, code_map: dict[str, str], fallback: str) -> str:
    text = _text(value)
    if not text:
        return fallback
    mapped = code_map.get(text.upper())
    if mapped:
        return mapped
    return text.lower()


def _raw_category_value(value: Any, fallback: str) -> str:
    # Keeps the literal source code (e.g. "B001") instead of translating it via a-codes.json/b-codes.json.
    text = _text(value)
    return text.upper() if text else fallback


def _poi_category_value(value: Any) -> str:
    # Raw spec codes (e.g. "F001") stay in metadata for round-trip; the IMDF category is unspecified.
    text = _text(value)
    if text and re.fullmatch(r"[A-Za-z]\d{3}", text):
        return "unspecified"
    return _category_value(text, {}, "unspecified")


def _display_point(geometry: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(geometry, dict):
        return None
    try:
        geom = shape(geometry)
    except Exception:
        return None
    if geom.is_empty:
        return None
    point = geom.representative_point()
    return {"type": "Point", "coordinates": [point.x, point.y]}


def _source_common(row: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    properties = row.get("properties") if isinstance(row.get("properties"), dict) else {}
    return {
        "source_file": properties.get("source_file"),
        "source_row_index": properties.get("source_row_index"),
        "source_part_index": properties.get("source_part_index"),
        "source_feature_ref": properties.get("source_feature_ref"),
        "status": "mapped",
        "issues": [],
        "metadata": metadata,
    }


def _stem_alias_type(stem: str) -> str | None:
    tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9]+", stem)]
    suffix2 = tuple(tokens[-2:]) if len(tokens) >= 2 else ()
    if suffix2 in ODC_CONNECT_ALIASES:
        return ODC_CONNECT_ALIASES[suffix2]
    if suffix2 in ODC_IGNORED_LAYER_SUFFIXES:
        return "__ignore__"
    if suffix2 in ODC_SUFFIX_ALIASES:
        return ODC_SUFFIX_ALIASES[suffix2]
    if tokens:
        return ODC_LAYER_ALIASES.get(tokens[-1])
    return None

def _effective_type(stem: str, detected_type: str | None) -> str:
    alias = _stem_alias_type(stem)
    if alias == "__ignore__":
        return ""
    return alias or (detected_type or "").strip().lower()


def _iter_source_rows(artifacts: ImportArtifacts) -> list[dict[str, Any]]:
    rows = artifacts.source_feature_collection.get("features", [])
    return rows if isinstance(rows, list) else []


def _rows_by_type(artifacts: ImportArtifacts) -> dict[str, list[tuple[dict[str, Any], dict[str, Any]]]]:
    file_types = {item.stem: _effective_type(item.stem, item.detected_type) for item in artifacts.files}
    grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for row in _iter_source_rows(artifacts):
        props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
        stem = props.get("source_file")
        if not isinstance(stem, str):
            continue
        feature_type = file_types.get(stem, "")
        if not feature_type:
            continue
        metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
        grouped[feature_type].append((row, metadata))
    return grouped


def _build_address(rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for feature_type in ("venue", "building"):
        if rows_by_type.get(feature_type):
            metadata = rows_by_type[feature_type][0][1]
            break
    address_id = str(uuid4())
    return {
        "type": "Feature",
        "id": address_id,
        "feature_type": "address",
        "geometry": None,
        "properties": {
            "address": _text(_metadata_get(metadata, ["address", "address1"])) or "",
            "unit": _text(_metadata_get(metadata, ["unit", "suite"])),
            "locality": _text(_metadata_get(metadata, ["locality", "city"])) or "",
            "province": _text(_metadata_get(metadata, ["province"])),
            "country": (_text(_metadata_get(metadata, ["country"])) or "JP").upper(),
            "postal_code": _text(_metadata_get(metadata, ["postal_code", "postalcode"])),
            "postal_code_ext": None,
            "postal_code_vanity": None,
            "status": "mapped",
            "issues": [],
        },
    }


def _build_venues(
    rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
    address_id: str,
    language: str,
) -> list[dict[str, Any]]:
    venues: list[dict[str, Any]] = []
    for row, metadata in rows_by_type.get("venue", []):
        geometry = row.get("geometry") if isinstance(row.get("geometry"), dict) else None
        if geometry is None:
            continue
        venue_id = _feature_id(_metadata_get(metadata, ["id"]))
        venues.append(
            {
                "type": "Feature",
                "id": venue_id,
                "feature_type": "venue",
                "geometry": geometry,
                "properties": {
                    "category": _raw_category_value(_metadata_get(metadata, ["category", "venue_category"]), "unspecified"),
                    "restriction": _text(_metadata_get(metadata, ["restriction", "restrict", "restricted"])),
                    "name": _label(_metadata_get(metadata, ["name", "venue_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "hours": _text(_metadata_get(metadata, ["hours", "hours1"])),
                    "phone": _text(_metadata_get(metadata, ["phone"])),
                    "website": _text(_metadata_get(metadata, ["website", "url"])),
                    "display_point": _display_point(geometry),
                    "address_id": address_id,
                    **_source_common(row, metadata),
                },
            }
        )
    return venues


def _build_buildings(
    rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
    address_id: str,
    language: str,
) -> list[dict[str, Any]]:
    buildings: list[dict[str, Any]] = []
    for row, metadata in rows_by_type.get("building", []):
        source_geometry = row.get("geometry") if isinstance(row.get("geometry"), dict) else None
        building_id = _feature_id(_metadata_get(metadata, ["id"]))
        enriched_metadata = dict(metadata)
        if source_geometry is not None:
            enriched_metadata.setdefault("__odc_geometry", source_geometry)
        buildings.append(
            {
                "type": "Feature",
                "id": building_id,
                "feature_type": "building",
                "geometry": None,
                "properties": {
                    "category": _category_value(_metadata_get(metadata, ["category", "building_category"]), {}, "unspecified"),
                    "restriction": _text(_metadata_get(metadata, ["restriction", "restrict", "restricted"])),
                    "name": _label(_metadata_get(metadata, ["name", "building_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "display_point": _display_point(source_geometry),
                    "address_id": address_id,
                    **_source_common(row, enriched_metadata),
                },
            }
        )
    return buildings


def _safe_union(geoms: list[Any]) -> Any | None:
    """Union geometries, tolerating invalid or near-coincident source data.

    GEOS raises a TopologyException ("side location conflict") when unioning
    polygons whose edges nearly coincide, which is common in ODC column data.
    Retry with each part made valid and the operation snapped to a fine grid,
    then fall back to an envelope union that cannot side-location conflict.
    """
    cleaned = [geom for geom in geoms if geom is not None and not geom.is_empty]
    if not cleaned:
        return None
    try:
        return unary_union(cleaned)
    except GEOSException:
        pass
    valid: list[Any] = []
    for geom in cleaned:
        try:
            fixed = make_valid(geom)
        except Exception:
            continue
        if not fixed.is_empty:
            valid.append(fixed)
    if not valid:
        return None
    for grid_size in (1e-9, 1e-8, 1e-7, 1e-6):
        try:
            return union_all(valid, grid_size=grid_size)
        except GEOSException:
            continue
    try:
        return union_all([geom.envelope for geom in valid])
    except GEOSException:
        return None


def _build_levels(
    rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
    building_ids: list[str],
    language: str,
) -> tuple[list[dict[str, Any]], dict[str, str], dict[int, str]]:
    records_by_name: dict[str, dict[str, Any]] = {}
    level_id_by_source: dict[str, str] = {}
    level_id_by_ordinal: dict[int, str] = {}

    for row, metadata in rows_by_type.get("level", []):
        geometry = row.get("geometry") if isinstance(row.get("geometry"), dict) else None
        if geometry is None:
            continue
        source_id = _text(_metadata_get(metadata, ["id"]))
        ordinal = _int_value(_metadata_get(metadata, ["ordinal", "level_ordinal"])) or 0
        category = _text(_metadata_get(metadata, ["category"]))
        outdoor = _bool_value(_metadata_get(metadata, ["outdoor"]))
        if outdoor is None and category is not None:
            outdoor = category.strip() == "2"
        level_name = _metadata_get(metadata, ["name", "level_name"])
        short_name = _metadata_get(metadata, ["short_name", "shortname"])
        merge_key = _level_merge_key(level_name, short_name, ordinal)
        existing = records_by_name.get(merge_key)
        if existing is not None:
            level_id = existing["feature"]["id"]
            if source_id:
                level_id_by_source[source_id] = level_id
            level_id_by_ordinal.setdefault(ordinal, level_id)
            existing["geometries"].append(geometry)
            continue

        level_id = _feature_id(source_id)
        if source_id:
            level_id_by_source[source_id] = level_id
        level_id_by_ordinal.setdefault(ordinal, level_id)
        feature = {
            "type": "Feature",
            "id": level_id,
            "feature_type": "level",
            "geometry": geometry,
            "properties": {
                "category": "outdoor" if outdoor else "indoor",
                "restriction": _text(_metadata_get(metadata, ["restriction", "restrict", "restricted"])),
                "outdoor": bool(outdoor),
                "ordinal": ordinal,
                "name": _label(level_name, language) or _label(short_name, language) or {language: str(ordinal)},
                "short_name": _label(short_name, language) or _label(level_name, language) or {language: str(ordinal)},
                "display_point": _display_point(geometry),
                "address_id": None,
                "building_ids": building_ids,
                **_source_common(row, metadata),
            },
        }
        records_by_name[merge_key] = {"feature": feature, "geometries": [geometry]}

    levels: list[dict[str, Any]] = []
    for record in records_by_name.values():
        feature = record["feature"]
        geoms = []
        for payload in record["geometries"]:
            try:
                geom = shape(payload)
            except Exception:
                continue
            if not geom.is_empty:
                geoms.append(geom)
        if geoms:
            merged = _safe_union(geoms)
            if merged is not None and not merged.is_empty:
                merged_geometry = mapping(merged)
                feature["geometry"] = merged_geometry
                feature["properties"]["display_point"] = _display_point(merged_geometry)
        levels.append(feature)

    return levels, level_id_by_source, level_id_by_ordinal


def _synthesized_level_label(ordinal: int) -> str:
    if ordinal < 0:
        return f"B{abs(ordinal)}F"
    return f"{ordinal + 1}F"


def _ordinal_from_floor_code(code: str) -> int:
    match = re.fullmatch(r"(B|M)?(\d+)F", code)
    if not match:
        return 0
    prefix, number = match.group(1), int(match.group(2))
    if prefix == "B":
        return -number
    # Ground-floor-as-zero convention, matching detect_level_ordinal.
    return number - 1


def _synthesize_levels(
    artifacts: ImportArtifacts,
    rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
    building_ids: list[str],
    language: str,
) -> tuple[list[dict[str, Any]], dict[int, str]]:
    file_ordinals = {item.stem: item.detected_level for item in artifacts.files}
    file_labels = {item.stem: _floor_label_from_stem(item.stem) for item in artifacts.files}
    # Group by the filename floor label so mezzanine floors (e.g. "M2FL") that
    # carry no numeric ordinal still get a synthesized level; fall back to the
    # ordinal for files without a parseable floor label.
    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for feature_type in LEVEL_LINKED_TYPES:
        for row, _ in rows_by_type.get(feature_type, []):
            props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
            stem = props.get("source_file")
            label = file_labels.get(stem) if isinstance(stem, str) else None
            ordinal = file_ordinals.get(stem) if isinstance(stem, str) else None
            if label is None and ordinal is None:
                continue
            geometry = row.get("geometry")
            if not isinstance(geometry, dict):
                continue
            try:
                geom = shape(geometry)
            except Exception:
                continue
            if geom.is_empty or geom.geom_type not in {"Polygon", "MultiPolygon"}:
                continue
            key = label if label is not None else f"ordinal:{ordinal}"
            group = groups.get(key)
            if group is None:
                groups[key] = {"label": label, "ordinal": ordinal, "geoms": [geom]}
                order.append(key)
            else:
                if group["ordinal"] is None:
                    group["ordinal"] = ordinal
                group["geoms"].append(geom)

    levels: list[dict[str, Any]] = []
    level_id_by_ordinal: dict[int, str] = {}
    for key in order:
        group = groups[key]
        merged = _safe_union(group["geoms"])
        if merged is None or merged.is_empty:
            continue
        label = group["label"]
        ordinal = group["ordinal"]
        if ordinal is None:
            ordinal = _ordinal_from_floor_code(label) if label else 0
        level_name = label or _synthesized_level_label(ordinal)
        level_id = str(uuid4())
        level_id_by_ordinal.setdefault(ordinal, level_id)
        levels.append(
            {
                "type": "Feature",
                "id": level_id,
                "feature_type": "level",
                "geometry": mapping(merged),
                "properties": {
                    "category": "indoor",
                    "restriction": None,
                    "outdoor": False,
                    "ordinal": ordinal,
                    "name": {language: level_name},
                    "short_name": {language: level_name},
                    "display_point": _display_point(mapping(merged)),
                    "address_id": None,
                    "building_ids": building_ids,
                    "status": "mapped",
                    "issues": [],
                    "metadata": {},
                },
            }
        )
    return levels, level_id_by_ordinal


def _floor_code(value: Any) -> str | None:
    """Normalize a floor label ("2FL"/"2F"/"B1FL"/"M2FL") to a canonical code
    ("2F", "B1F", "M2F"). Returns None for non-floor text such as a year
    ("2024"), which has no trailing F."""
    text = _label_text(value)
    if not text:
        return None
    match = re.fullmatch(r"\s*(B|M)?(\d+)FL?\s*", text, re.IGNORECASE)
    if not match:
        return None
    prefix = (match.group(1) or "").upper()
    return f"{prefix}{int(match.group(2))}F"


def _floor_label_from_stem(stem: str) -> str | None:
    for token in re.findall(r"[A-Za-z0-9]+", stem):
        code = _floor_code(token)
        if code:
            return code
    return None


def _build_label_to_level(levels: list[dict[str, Any]]) -> dict[str, str]:
    label_to_level: dict[str, str] = {}
    for level in levels:
        props = level.get("properties") or {}
        for source in (props.get("short_name"), props.get("name")):
            code = _floor_code(source)
            if code:
                label_to_level.setdefault(code, str(level["id"]))
    return label_to_level


def _level_id_for_row(
    metadata: dict[str, Any],
    source_to_level: dict[str, str],
    ordinal_to_level: dict[int, str],
    fallback_ordinal: int | None,
    label_to_level: dict[str, str] | None = None,
    fallback_label: str | None = None,
) -> str | None:
    source_level = _text(_metadata_get(metadata, ["level_id", "floor_id", "floorid", "levelid"]))
    if source_level and source_level in source_to_level:
        return source_to_level[source_level]
    # The source level_id does not resolve to a level in this dataset (the 壁あり
    # column files carry floor UUIDs from a separate export). Link by the floor
    # parsed from the filename before falling back to the raw UUID.
    if fallback_label and label_to_level:
        mapped = label_to_level.get(fallback_label)
        if mapped:
            return mapped
    if fallback_ordinal is not None:
        mapped = ordinal_to_level.get(fallback_ordinal)
        if mapped:
            return mapped
    if source_level:
        try:
            return str(UUID(source_level))
        except ValueError:
            pass
    return None


def _build_level_linked_features(
    artifacts: ImportArtifacts,
    rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
    source_to_level: dict[str, str],
    ordinal_to_level: dict[int, str],
    label_to_level: dict[str, str],
    language: str,
) -> list[dict[str, Any]]:
    file_ordinals = {item.stem: item.detected_level for item in artifacts.files}
    file_labels = {item.stem: _floor_label_from_stem(item.stem) for item in artifacts.files}
    output: list[dict[str, Any]] = []

    for feature_type in ("unit", "opening", "fixture", "detail", "section", "kiosk", "amenity", "occupant", "floor_connect"):
        for row, metadata in rows_by_type.get(feature_type, []):
            geometry = row.get("geometry") if isinstance(row.get("geometry"), dict) else None
            if geometry is None:
                continue
            props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
            stem = props.get("source_file")
            fallback_ordinal = file_ordinals.get(stem) if isinstance(stem, str) else None
            fallback_label = file_labels.get(stem) if isinstance(stem, str) else None
            level_id = _level_id_for_row(
                metadata,
                source_to_level,
                ordinal_to_level,
                fallback_ordinal,
                label_to_level=label_to_level,
                fallback_label=fallback_label,
            )
            if feature_type in LEVEL_LINKED_TYPES and not level_id:
                continue

            feature_id = _feature_id(_metadata_get(metadata, ["id"]))
            common = _source_common(row, metadata)
            if feature_type == "unit":
                properties = {
                    "category": _raw_category_value(_metadata_get(metadata, ["category", "imdf_cat", "type"]), "unspecified"),
                    "restriction": _text(_metadata_get(metadata, ["restriction", "restrict", "restricted"])),
                    "accessibility": _parse_list(_metadata_get(metadata, ["accessibility", "accessible"])),
                    "name": _label(_metadata_get(metadata, ["name", "unit_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "level_id": level_id,
                    "display_point": _display_point(geometry),
                    **common,
                }
            elif feature_type == "opening":
                properties = {
                    "category": _category_value(_metadata_get(metadata, ["category", "type"]), {}, "pedestrian"),
                    "accessibility": _parse_list(_metadata_get(metadata, ["accessibility", "accessible"])),
                    "access_control": _parse_list(_metadata_get(metadata, ["access_control", "access_con", "accessctrl"])),
                    "door": None,
                    "name": _label(_metadata_get(metadata, ["name", "opening_name"]), language),
                    "alt_name": None,
                    "level_id": level_id,
                    "display_point": _display_point(geometry),
                    **common,
                }
            elif feature_type == "fixture":
                properties = {
                    "category": _category_value(_metadata_get(metadata, ["category", "type"]), {}, "unspecified"),
                    "name": _label(_metadata_get(metadata, ["name", "fixture_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "anchor_id": None,
                    "level_id": level_id,
                    "display_point": _display_point(geometry),
                    **common,
                }
            elif feature_type == "detail":
                properties = {"level_id": level_id, **common}
            elif feature_type == "section":
                properties = {
                    "category": _category_value(_metadata_get(metadata, ["category", "type"]), {}, "walkway"),
                    "name": _label(_metadata_get(metadata, ["name", "section_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "restriction": _text(_metadata_get(metadata, ["restriction", "restrict", "restricted"])),
                    "level_id": level_id,
                    **common,
                }
            elif feature_type == "amenity":
                enriched_metadata = dict(metadata)
                if level_id:
                    enriched_metadata["__odc_level_id"] = level_id
                common = _source_common(row, enriched_metadata)
                properties = {
                    "category": _poi_category_value(_metadata_get(metadata, ["category", "type"])),
                    "name": _label(_metadata_get(metadata, ["name", "facility_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "hours": _text(_metadata_get(metadata, ["hours", "hours1"])),
                    "phone": _text(_metadata_get(metadata, ["phone"])),
                    "website": _text(_metadata_get(metadata, ["website", "url"])),
                    "unit_ids": None,
                    "address_id": None,
                    "correlation_id": None,
                    **common,
                }
            elif feature_type == "occupant":
                enriched_metadata = dict(metadata)
                enriched_metadata["__odc_geometry"] = geometry
                if level_id:
                    enriched_metadata["__odc_level_id"] = level_id
                common = _source_common(row, enriched_metadata)
                properties = {
                    "category": _poi_category_value(_metadata_get(metadata, ["category", "type"])),
                    "name": _label(_metadata_get(metadata, ["name", "occupant_name"]), language),
                    "hours": _text(_metadata_get(metadata, ["hours", "hours1"])),
                    "phone": _text(_metadata_get(metadata, ["phone"])),
                    "website": _text(_metadata_get(metadata, ["website", "url"])),
                    # ponytail: anchor_id stays null; emit anchor point pairs on import if Apple-valid occupants are needed
                    "anchor_id": None,
                    "correlation_id": None,
                    **common,
                }
                geometry = None
            elif feature_type == "floor_connect":
                # ODC 階層間接続点 (Floor_Connect): preserve spec fields in metadata for round-trip.
                enriched_metadata = dict(metadata)
                if level_id:
                    enriched_metadata["__odc_level_id"] = level_id
                common = _source_common(row, enriched_metadata)
                properties = {
                    "level_id": level_id,
                    **common,
                }
            else:
                properties = {
                    "name": _label(_metadata_get(metadata, ["name", "kiosk_name"]), language),
                    "alt_name": _label(_metadata_get(metadata, ["alt_name", "altname"]), language),
                    "level_id": level_id,
                    "anchor_id": _text(_metadata_get(metadata, ["anchor_id", "anchorid"])),
                    **common,
                }

            output.append(
                {
                    "type": "Feature",
                    "id": feature_id,
                    "feature_type": feature_type,
                    "geometry": geometry,
                    "properties": properties,
                }
            )

    return output


def _fallback_union_geometry(features: list[dict[str, Any]]) -> dict[str, Any] | None:
    geoms = []
    for feature in features:
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict):
            continue
        try:
            geom = shape(geometry)
        except Exception:
            continue
        if not geom.is_empty and geom.geom_type in {"Polygon", "MultiPolygon"}:
            geoms.append(geom)
    if not geoms:
        return None
    merged = _safe_union(geoms)
    if merged is None or merged.is_empty:
        return None
    return mapping(merged)


def _ensure_core_features(
    features: list[dict[str, Any]],
    address_id: str,
    language: str,
) -> list[dict[str, Any]]:
    output = list(features)
    venue_rows = [item for item in output if item.get("feature_type") == "venue"]
    building_rows = [item for item in output if item.get("feature_type") == "building"]
    level_rows = [item for item in output if item.get("feature_type") == "level"]
    polygon_geometry = _fallback_union_geometry(level_rows or [item for item in output if item.get("feature_type") == "unit"])

    if not building_rows:
        output.append(
            {
                "type": "Feature",
                "id": str(uuid4()),
                "feature_type": "building",
                "geometry": None,
                "properties": {
                    "category": "unspecified",
                    "name": {language: "Building"},
                    "alt_name": None,
                    "restriction": None,
                    "display_point": _display_point(polygon_geometry),
                    "address_id": address_id,
                    "status": "mapped",
                    "issues": [],
                    "metadata": {"__odc_geometry": polygon_geometry} if polygon_geometry else {},
                },
            }
        )
        building_rows = [output[-1]]

    building_ids = [str(item.get("id")) for item in building_rows if item.get("id")]
    for level in level_rows:
        props = level.get("properties")
        if isinstance(props, dict) and not props.get("building_ids"):
            props["building_ids"] = building_ids

    if not venue_rows and polygon_geometry is not None:
        output.append(
            {
                "type": "Feature",
                "id": str(uuid4()),
                "feature_type": "venue",
                "geometry": polygon_geometry,
                "properties": {
                    "category": "unspecified",
                    "restriction": None,
                    "name": {language: "Venue"},
                    "alt_name": None,
                    "hours": None,
                    "phone": None,
                    "website": None,
                    "display_point": _display_point(polygon_geometry),
                    "address_id": address_id,
                    "status": "mapped",
                    "issues": [],
                    "metadata": {},
                },
            }
        )

    return output


def _build_footprints(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    footprints: list[dict[str, Any]] = []
    for feature in features:
        if feature.get("feature_type") != "building":
            continue
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
        geometry = metadata.get("__odc_geometry")
        if not isinstance(geometry, dict):
            continue
        footprints.append(
            {
                "type": "Feature",
                "id": str(uuid4()),
                "feature_type": "footprint",
                "geometry": geometry,
                "properties": {
                    "category": "ground",
                    "name": None,
                    "building_ids": [str(feature.get("id"))],
                    "status": "mapped",
                    "issues": [],
                    "metadata": {},
                },
            }
        )
    return footprints


def _dedupe_feature_ids(features: list[dict[str, Any]]) -> None:
    # Exploded multipart source rows share their source row's id; keep the first, regenerate the rest.
    seen: set[str] = set()
    for feature in features:
        feature_id = str(feature.get("id"))
        if feature_id in seen:
            feature_id = str(uuid4())
            feature["id"] = feature_id
        seen.add(feature_id)


# Categories IMDF models as units but the spec (別表8.5.1 設置物要素) models as
# Fixtures: columns are C001 and planting is C009. Neither has a Space code, so a
# unit tagged with one is redirected instead of landing under Space with the
# その他部屋 fallback.
FIXTURE_ONLY_UNIT_CATEGORIES = {"column", "vegetation", "planting"}


def _redirect_fixture_only_units(
    rows_by_type: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]],
) -> None:
    unit_rows = rows_by_type.get("unit")
    if not unit_rows:
        return
    fixture_rows = rows_by_type.setdefault("fixture", [])
    keep: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for row, metadata in unit_rows:
        category = _text(_metadata_get(metadata, ["category", "imdf_cat", "type"]))
        if category is not None and category.lower() in FIXTURE_ONLY_UNIT_CATEGORIES:
            fixture_rows.append((row, metadata))
            continue
        keep.append((row, metadata))
    if len(keep) != len(unit_rows):
        rows_by_type["unit"] = keep


def build_imdf_shapefile_feature_collection(artifacts: ImportArtifacts, language: str = "en") -> dict[str, Any]:
    rows_by_type = _rows_by_type(artifacts)
    _redirect_fixture_only_units(rows_by_type)
    address = _build_address(rows_by_type)
    address_id = str(address["id"])
    venues = _build_venues(rows_by_type, address_id=address_id, language=language)
    buildings = _build_buildings(rows_by_type, address_id=address_id, language=language)
    building_ids = [str(item["id"]) for item in buildings] or []
    levels, source_to_level, ordinal_to_level = _build_levels(rows_by_type, building_ids, language=language)
    if not levels:
        synthesized_levels, synthesized_by_ordinal = _synthesize_levels(artifacts, rows_by_type, building_ids, language)
        levels = synthesized_levels
        ordinal_to_level.update(synthesized_by_ordinal)

    label_to_level = _build_label_to_level(levels)
    linked_features = _build_level_linked_features(
        artifacts=artifacts,
        rows_by_type=rows_by_type,
        source_to_level=source_to_level,
        ordinal_to_level=ordinal_to_level,
        label_to_level=label_to_level,
        language=language,
    )
    features = [address, *venues, *buildings, *levels, *linked_features]
    features = _ensure_core_features(features, address_id=address_id, language=language)
    features.extend(_build_footprints(features))
    _dedupe_feature_ids(features)
    return {"type": "FeatureCollection", "features": features}


def import_imdf_shapefile_blobs(
    file_blobs: list[tuple[str, bytes]],
    filename_keywords_path: str | Path,
) -> ImportArtifacts:
    if any(Path(filename).suffix.lower() == ".gpkg" for filename, _ in file_blobs):
        raise ValueError("IMDF-schema shapefile import only accepts shapefile components or ZIP archives.")

    artifacts = import_file_blobs(file_blobs, filename_keywords_path=filename_keywords_path)
    if any(item.source_format != "shapefile" for item in artifacts.files):
        raise ValueError("IMDF-schema shapefile import only accepts shapefile sources.")

    feature_collection = build_imdf_shapefile_feature_collection(artifacts)
    return ImportArtifacts(
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        source_feature_collection=artifacts.source_feature_collection,
        feature_collection=feature_collection,
        warnings=artifacts.warnings,
    )
