"""Append additional source data to a session that already holds an IMDF dataset.

A session is a flat bag of IMDF features, so an append is two steps: run the
incoming files through one of the existing import pipelines, then *rebind* what
comes out onto the ids the session already uses. The rebind is the whole point.
Every pipeline mints its own address/venue/building/levels, and appending those
verbatim would leave the dataset with a second venue and a duplicate of every
floor it already had.

Appends are staged before they are applied. Review-screen edits live only in
``session.feature_collection`` and there is no undo for them, so a batch is
described to the caller in full before it touches anything.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import copy
import json
import math
import statistics
from pathlib import Path
import shutil
from typing import Any
from uuid import uuid4

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from backend.src.generator import generate_feature_collection
from backend.src.geometry import covers_within_tolerance, grow_to_cover
from backend.src.imdf_reader import read_imdf_zip
from backend.src.imdf_shapefile_importer import (
    _canonical_floor_label,
    _label_text,
    _level_merge_key,
    import_imdf_shapefile_blobs,
)
from backend.src.importer import DROPPED_ROWS_SAMPLE_LIMIT, import_file_blobs
from backend.src.schemas import (
    AddressInput,
    AppendAlignment,
    AppendCandidateFeature,
    AppendCandidateFeaturesResponse,
    AppendLayerSelection,
    AppendSelection,
    AppendBatchSummary,
    AppendCommitResponse,
    AppendFileOverride,
    AppendFileSummary,
    AppendHostLevel,
    AppendLevelDecision,
    AppendLevelMatch,
    AppendStageResponse,
    AppendUndoResponse,
    CleanupSummary,
    ImportedFile,
    ProjectWizardState,
    SessionRecord,
    WizardMappingsState,
    WizardState,
)


# Core features the host session already owns. A batch's copies are dropped and
# every reference to them is redirected at the host's own ids.
HOST_OWNED_TYPES = ("address", "venue", "building")
# Footprints belong to a building; dropping the batch's buildings drops these too.
DROPPED_TYPES = frozenset({*HOST_OWNED_TYPES, "footprint"})

REFERENCE_KEYS_SINGLE = ("level_id", "address_id", "anchor_id")
REFERENCE_KEYS_LIST = ("building_ids", "unit_ids")

BATCH_PROPERTY = "import_batch_id"

SUPPORTED_PROFILES = ("imdf_shapefile", "imdf", "standard")
# Profiles that read source layers, as opposed to an already-built IMDF archive.
SOURCE_LAYER_PROFILES = ("imdf_shapefile", "standard")


class AppendError(ValueError):
    """A batch cannot be staged or committed as described."""


@dataclass(slots=True)
class StagedAppend:
    """An import that has been read and mapped but not yet merged into a session."""

    batch_id: str
    session_id: str
    profile: str
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    feature_collection: dict[str, Any]
    source_feature_collection: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    # Only the standard profile maps attributes, and only it can be re-staged.
    mappings: WizardMappingsState | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "session_id": self.session_id,
            "profile": self.profile,
            "files": [item.model_dump(mode="json") for item in self.files],
            "cleanup_summary": self.cleanup_summary.model_dump(mode="json"),
            "feature_collection": self.feature_collection,
            "source_feature_collection": self.source_feature_collection,
            "warnings": self.warnings,
            "mappings": self.mappings.model_dump(mode="json") if self.mappings else None,
        }

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> "StagedAppend":
        return cls(
            batch_id=str(payload["batch_id"]),
            session_id=str(payload["session_id"]),
            profile=str(payload["profile"]),
            files=[ImportedFile.model_validate(item) for item in payload.get("files") or []],
            cleanup_summary=CleanupSummary.model_validate(payload.get("cleanup_summary") or {}),
            feature_collection=payload.get("feature_collection") or {"type": "FeatureCollection", "features": []},
            source_feature_collection=payload.get("source_feature_collection")
            or {"type": "FeatureCollection", "features": []},
            warnings=list(payload.get("warnings") or []),
            mappings=WizardMappingsState.model_validate(payload["mappings"]) if payload.get("mappings") else None,
        )


@dataclass(frozen=True, slots=True)
class LevelSummary:
    """The identity a level can be matched on, from either side of an append."""

    id: str
    name: str | None
    short_name: str | None
    ordinal: int | None
    label: str | None
    merge_key: str | None


# ---------------------------------------------------------------------------
# Reading features
# ---------------------------------------------------------------------------


def _features_of(collection: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(collection, dict):
        return []
    features = collection.get("features")
    return features if isinstance(features, list) else []


def _coerce_ordinal(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _level_summary(feature: dict[str, Any]) -> LevelSummary:
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    name = _label_text(props.get("name"))
    short_name = _label_text(props.get("short_name"))
    ordinal = _coerce_ordinal(props.get("ordinal"))
    label = _canonical_floor_label(props.get("short_name")) or _canonical_floor_label(props.get("name"))
    merge_key = _level_merge_key(name, short_name, ordinal or 0) if (name or short_name) else None
    return LevelSummary(
        id=str(feature.get("id")),
        name=name,
        short_name=short_name,
        ordinal=ordinal,
        label=label,
        merge_key=merge_key,
    )


def _level_summaries(features: list[dict[str, Any]]) -> list[LevelSummary]:
    return [
        _level_summary(feature)
        for feature in features
        if isinstance(feature, dict) and feature.get("feature_type") == "level" and feature.get("id") is not None
    ]


def _feature_level_id(feature: dict[str, Any]) -> str | None:
    """The level a feature hangs off, wherever it is recorded.

    Amenities, occupants and floor connects carry no ``level_id`` property; the
    ODC importer stashes theirs in ``metadata.__odc_level_id``.
    """
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    level_id = props.get("level_id")
    if isinstance(level_id, str) and level_id:
        return level_id
    metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
    odc_level_id = metadata.get("__odc_level_id")
    return odc_level_id if isinstance(odc_level_id, str) and odc_level_id else None


def _unlinked_unit_counts(features: list[dict[str, Any]]) -> tuple[int, int]:
    """How many of the session's units the shapefile exports cannot write back.

    Those exports rewrite rows in the files that were uploaded, keyed by
    ``source_file`` plus ``source_row_index``. A session opened from an IMDF
    archive has no such rows at all, so adding a layer to one flips the
    roundtrip export from a clear refusal into a partial archive holding only
    what was added. Worth saying before the append, not after the download.
    """
    total = 0
    unlinked = 0
    for feature in features:
        if feature.get("feature_type") != "unit":
            continue
        total += 1
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        if not props.get("source_file") and not props.get("source_feature_ref"):
            unlinked += 1
    return unlinked, total


def _ids_by_type(features: list[dict[str, Any]], feature_type: str) -> list[str]:
    return [
        str(feature.get("id"))
        for feature in features
        if isinstance(feature, dict) and feature.get("feature_type") == feature_type and feature.get("id") is not None
    ]


# ---------------------------------------------------------------------------
# Matching a batch's levels to the session's
# ---------------------------------------------------------------------------


def _match_level(candidate: LevelSummary, hosts: list[LevelSummary]) -> tuple[str, str | None, list[str]]:
    """Match one incoming level against the session's levels.

    Name before floor label before ordinal, because floor labels are not unique:
    one floor routinely holds several levels (Shinjuku 2F is three of them), so
    "2F" alone cannot say which is meant while the name can. Ordinal comes last
    because a source file with no ordinal column defaults every level to 0, and
    matching on that would bind every incoming level to the same host.

    Returns the basis, the matched host id, and - when several hosts tie - the
    ids to offer the caller as a choice.
    """
    for basis, key in (("name", "merge_key"), ("floor_label", "label"), ("ordinal", "ordinal")):
        value = getattr(candidate, key)
        if value is None:
            continue
        same = [host for host in hosts if getattr(host, key) == value]
        if len(same) == 1:
            return basis, same[0].id, []
        if len(same) > 1:
            return "ambiguous", None, [host.id for host in same]
    return "unmatched", None, []


def _host_level_model(summary: LevelSummary) -> AppendHostLevel:
    return AppendHostLevel(
        id=summary.id,
        name=summary.name,
        short_name=summary.short_name,
        ordinal=summary.ordinal,
        label=summary.label,
    )


def plan_append(session: SessionRecord, staged: StagedAppend) -> AppendStageResponse:
    """Describe what committing ``staged`` into ``session`` would do."""
    host_features = _features_of(session.feature_collection)
    host_levels = _level_summaries(host_features)
    host_by_id = {item.id: item for item in host_levels}
    host_ids = {str(feature.get("id")) for feature in host_features if feature.get("id") is not None}

    candidate_features = _features_of(staged.feature_collection)
    candidate_levels = _level_summaries(candidate_features)

    features_per_level: dict[str, int] = {}
    feature_counts: dict[str, int] = {}
    collisions: list[str] = []
    for feature in candidate_features:
        feature_type = str(feature.get("feature_type") or "")
        if feature_type in DROPPED_TYPES:
            continue
        feature_counts[feature_type] = feature_counts.get(feature_type, 0) + 1
        level_id = _feature_level_id(feature)
        if level_id:
            features_per_level[level_id] = features_per_level.get(level_id, 0) + 1
        feature_id = str(feature.get("id"))
        if feature_id in host_ids:
            collisions.append(feature_id)

    matches: list[AppendLevelMatch] = []
    needs_decisions = False
    for candidate in candidate_levels:
        basis, host_id, options = _match_level(candidate, host_levels)
        if host_id is None:
            needs_decisions = True
        matches.append(
            AppendLevelMatch(
                candidate_level_id=candidate.id,
                name=candidate.name,
                short_name=candidate.short_name,
                ordinal=candidate.ordinal,
                label=candidate.label,
                feature_count=features_per_level.get(candidate.id, 0),
                match_basis=basis,
                host_level_id=host_id,
                host_level_options=[_host_level_model(host_by_id[item]) for item in options if item in host_by_id],
            )
        )

    warnings = list(staged.warnings)
    unlinked, total_units = _unlinked_unit_counts(host_features)
    if unlinked and staged.profile in SOURCE_LAYER_PROFILES:
        warnings.append(
            f"{unlinked} of the {total_units} rooms already here did not come from an uploaded shapefile. "
            "A shapefile export will only be able to write back what you add now; IMDF export is unaffected."
        )

    alignment = measure_alignment(session, staged)
    if alignment is None and session.coordinate_alignment is not None:
        # No ids in common this time, but the dataset has already been shown to
        # sit off the source frame; the same shift applies.
        alignment = session.coordinate_alignment.model_copy(update={"from_session": True})

    return AppendStageResponse(
        session_id=session.session_id,
        batch_id=staged.batch_id,
        profile=staged.profile,
        files=[
            AppendFileSummary(
                stem=item.stem,
                geometry_type=item.geometry_type,
                feature_count=item.feature_count,
                detected_type=item.detected_type,
                detected_level=item.detected_level,
                level_name=item.level_name,
                short_name=item.short_name,
                outdoor=item.outdoor,
                level_category=item.level_category,
                confidence=item.confidence,
                source_format=item.source_format,
                attribute_columns=list(item.attribute_columns),
                crs_detected=item.crs_detected,
                warnings=list(item.warnings),
            )
            for item in staged.files
        ],
        levels=matches,
        host_levels=[_host_level_model(item) for item in host_levels],
        feature_counts=feature_counts,
        id_collisions=len(collisions),
        id_collision_sample=collisions[:20],
        needs_decisions=needs_decisions,
        needs_mapping=staged.profile == "standard" and _needs_mapping(staged.files, staged.mappings),
        alignment=alignment,
        mappings=staged.mappings,
        cleanup_summary=staged.cleanup_summary,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# The standard profile: map attributes without regenerating the host
# ---------------------------------------------------------------------------


def _host_language(features: list[dict[str, Any]]) -> str:
    """The language the dataset already labels things in."""
    for feature in features:
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        for key in ("name", "short_name"):
            label = props.get(key)
            if isinstance(label, dict):
                for language, text in label.items():
                    if isinstance(language, str) and language and isinstance(text, str) and text.strip():
                        return language
    return "en"


def _scratch_project(session: SessionRecord) -> ProjectWizardState | None:
    """The project the scratch generation runs under.

    Its venue and address are thrown away by the rebind, so when the host has no
    wizard project this exists only to carry the language: without it a dataset
    labelled in Japanese would gain English-keyed labels on everything added.
    """
    if session.wizard.project is not None:
        return session.wizard.project.model_copy(deep=True)
    language = _host_language(_features_of(session.feature_collection))
    if language == "en":
        return None
    return ProjectWizardState(
        venue_name="",
        venue_category="unspecified",
        language=language,
        address=AddressInput(locality="", country=""),
    )


def _apply_file_overrides(files: list[ImportedFile], overrides: list[AppendFileOverride]) -> list[ImportedFile]:
    by_stem = {item.stem: item for item in overrides}
    unknown = sorted(set(by_stem) - {item.stem for item in files})
    if unknown:
        raise AppendError("Overrides name files that are not in this batch: " + ", ".join(unknown))
    updated: list[ImportedFile] = []
    for item in files:
        override = by_stem.get(item.stem)
        if override is None:
            updated.append(item)
            continue
        changes = override.model_dump(exclude_unset=True, exclude_none=True)
        changes.pop("stem", None)
        updated.append(item.model_copy(update=changes))
    return updated


def _build_standard_candidate(
    session: SessionRecord,
    files: list[ImportedFile],
    source_feature_collection: dict[str, Any],
    mappings: WizardMappingsState,
    unit_categories_path: str | Path,
) -> dict[str, Any]:
    """Run the wizard's generator over the incoming files alone.

    The host session is never regenerated: ``generate_feature_collection``
    rebuilds a feature collection from source rows and wizard state, which would
    throw away every edit made on the review screen. So the batch is generated
    in a scratch session that holds only the new files, and the rebind attaches
    the result to the host's ids.
    """
    now = datetime.now(UTC)
    scratch = SessionRecord(
        session_id=f"append-scratch-{uuid4()}",
        created_at=now,
        last_accessed=now,
        files=[item.model_copy(deep=True) for item in files],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
        source_feature_collection=copy.deepcopy(source_feature_collection),
        wizard=WizardState(
            project=_scratch_project(session),
            mappings=mappings.model_copy(deep=True),
            footprint=session.wizard.footprint.model_copy(deep=True),
            company_mappings=dict(session.wizard.company_mappings),
            company_default_category=session.wizard.company_default_category,
        ),
    )
    return generate_feature_collection(
        scratch,
        unit_categories_path=str(unit_categories_path),
        level_geometry_by_ordinal=_host_level_geometry_by_ordinal(_features_of(session.feature_collection)),
    )


def _host_level_geometry_by_ordinal(features: list[dict[str, Any]]) -> dict[int, Any]:
    """The shape of each floor the session already has, keyed by ordinal.

    A batch that holds only an openings or fixtures layer has no polygons to
    build a level outline from, and the generator drops every feature whose
    level it could not build. Since the batch is being added to floors that
    already exist, theirs will do — and the candidate level carrying it is
    merged away by the rebind anyway.
    """
    geoms_by_ordinal: dict[int, list[Any]] = {}
    for feature in features:
        if feature.get("feature_type") != "level":
            continue
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        ordinal = _coerce_ordinal(props.get("ordinal"))
        geometry = feature.get("geometry")
        if ordinal is None or not isinstance(geometry, dict):
            continue
        try:
            geom = shape(geometry)
        except Exception:
            continue
        if not geom.is_empty and geom.geom_type in {"Polygon", "MultiPolygon"}:
            geoms_by_ordinal.setdefault(ordinal, []).append(geom)
    return {ordinal: unary_union(geoms) for ordinal, geoms in geoms_by_ordinal.items()}


def _needs_mapping(files: list[ImportedFile], mappings: WizardMappingsState | None) -> bool:
    """True when units would all fall back to the default category."""
    if not any((item.detected_type or "").lower() == "unit" for item in files):
        return False
    return not (mappings and mappings.unit.code_column)


# ---------------------------------------------------------------------------
# Choosing part of a batch
# ---------------------------------------------------------------------------


def _attribute_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text[:200]


def _representative_point(feature: dict[str, Any]) -> tuple[float, float] | None:
    """A point to place the feature at on the selection map.

    Occupants and buildings carry no geometry of their own; the ODC importer
    keeps theirs in ``metadata.__odc_geometry``, so look there before giving up.
    """
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
        geometry = metadata.get("__odc_geometry")
    if not isinstance(geometry, dict):
        return None
    try:
        geom = shape(geometry)
    except Exception:
        return None
    if geom.is_empty:
        return None
    point = geom.representative_point()
    return (float(point.x), float(point.y))


def _already_imported_rows(session: SessionRecord) -> set[tuple[str, int]]:
    """Source rows this session has already taken in, keyed as the exports key them."""
    taken: set[tuple[str, int]] = set()
    for row in _features_of(session.source_feature_collection):
        props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
        stem = props.get("source_file")
        row_index = props.get("source_row_index")
        if isinstance(stem, str) and isinstance(row_index, int):
            taken.add((stem, row_index))
    return taken


def _candidate_geometry(feature: dict[str, Any]) -> dict[str, Any] | None:
    """The shape to draw, from wherever this feature type keeps it."""
    geometry = feature.get("geometry")
    if isinstance(geometry, dict):
        return geometry
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
    stashed = metadata.get("__odc_geometry")
    return stashed if isinstance(stashed, dict) else None


def candidate_features(session: SessionRecord, staged: StagedAppend) -> AppendCandidateFeaturesResponse:
    """The batch flattened for the selection UI."""
    taken = _already_imported_rows(session)
    columns_by_stem: dict[str, list[str]] = {}
    rows: list[AppendCandidateFeature] = []
    level_labels = {
        item.id: item.name or item.short_name or item.label
        for item in _level_summaries(_features_of(staged.feature_collection))
    }

    for feature in _features_of(staged.feature_collection):
        feature_type = str(feature.get("feature_type") or "")
        if feature_type in DROPPED_TYPES or feature_type == "level":
            continue
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
        stem = props.get("source_file") if isinstance(props.get("source_file"), str) else None
        row_index = props.get("source_row_index") if isinstance(props.get("source_row_index"), int) else None

        attributes = {str(key): _attribute_text(value) for key, value in metadata.items() if not str(key).startswith("__")}
        if stem:
            known = columns_by_stem.setdefault(stem, [])
            for key in attributes:
                if key not in known:
                    known.append(key)

        rows.append(
            AppendCandidateFeature(
                id=str(feature.get("id")),
                feature_type=feature_type,
                stem=stem,
                source_row_index=row_index,
                name=_label_text(props.get("name")),
                category=props.get("category") if isinstance(props.get("category"), str) else None,
                level_id=_feature_level_id(feature),
                level_label=level_labels.get(_feature_level_id(feature) or ""),
                point=_representative_point(feature),
                geometry=_candidate_geometry(feature),
                attributes=attributes,
                already_imported=bool(stem and row_index is not None and (stem, row_index) in taken),
            )
        )

    return AppendCandidateFeaturesResponse(
        session_id=session.session_id,
        batch_id=staged.batch_id,
        features=rows,
        columns_by_stem={stem: sorted(columns) for stem, columns in columns_by_stem.items()},
    )


def _passes_selection(feature: dict[str, Any], selection: AppendSelection, layers: dict[str, AppendLayerSelection]) -> bool:
    feature_type = str(feature.get("feature_type") or "")
    if selection.feature_types is not None and feature_type not in selection.feature_types:
        return False

    if selection.level_ids is not None:
        level_id = _feature_level_id(feature)
        if level_id not in selection.level_ids:
            return False

    if selection.categories is not None:
        category = (feature.get("properties") or {}).get("category")
        if (category if isinstance(category, str) else "") not in selection.categories:
            return False

    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    stem = props.get("source_file")
    if isinstance(stem, str):
        layer = layers.get(stem)
        if layer is not None:
            if not layer.included:
                return False
            if layer.filter_column:
                metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
                value = _attribute_text(metadata.get(layer.filter_column))
                if value not in set(layer.filter_values):
                    return False

    if selection.bbox is not None:
        point = _representative_point(feature)
        if point is None:
            return False
        minx, miny, maxx, maxy = selection.bbox
        if not (minx <= point[0] <= maxx and miny <= point[1] <= maxy):
            return False

    return True


def select_feature_ids(
    session: SessionRecord,
    staged: StagedAppend,
    selection: AppendSelection | None,
) -> tuple[set[str], int, int]:
    """Resolve a selection into the candidate ids to keep.

    Returns the kept ids, how many were left out by the selection, and how many
    were dropped because the session already holds that source row.

    Levels are never subject to selection: they carry the floors the caller has
    already decided about, and dropping one here would orphan whatever it holds.
    """
    taken = _already_imported_rows(session)
    layers = {item.stem: item for item in (selection.layers if selection else [])}
    excluded = set(selection.excluded_feature_ids) if selection else set()
    included = set(selection.included_feature_ids) if selection else set()

    kept: set[str] = set()
    deselected = 0
    skipped = 0
    for feature in _features_of(staged.feature_collection):
        feature_type = str(feature.get("feature_type") or "")
        if feature_type in DROPPED_TYPES:
            continue
        feature_id = str(feature.get("id"))
        if feature_type == "level":
            kept.add(feature_id)
            continue

        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        stem = props.get("source_file")
        row_index = props.get("source_row_index")
        if isinstance(stem, str) and isinstance(row_index, int) and (stem, row_index) in taken:
            skipped += 1
            continue

        if feature_id in included:
            kept.add(feature_id)
            continue
        # In "picked" mode nothing is in unless it was named, so the filters
        # only decide what could have been picked, never what comes in.
        if selection is not None and selection.base == "picked":
            deselected += 1
            continue
        if feature_id in excluded or (selection is not None and not _passes_selection(feature, selection, layers)):
            deselected += 1
            continue
        kept.add(feature_id)

    return kept, deselected, skipped


# ---------------------------------------------------------------------------
# Putting a batch on the same frame as the dataset it joins
# ---------------------------------------------------------------------------

# Enough matches to trust a median, and the spread at which a shift stops
# looking like a datum offset and starts looking like two different surveys.
MIN_ALIGNMENT_SAMPLES = 3
ALIGNMENT_CONSISTENT_CM = 25.0
METRES_PER_DEGREE_LAT = 110_540.0
METRES_PER_DEGREE_LON = 111_320.0


def _normalised_id(value: Any) -> str | None:
    """Ids compared across datasets that disagree about dashes (ODC strips them)."""
    if value is None:
        return None
    text = str(value).strip()
    return text.replace("-", "").lower() or None


def _anchor_point(feature: dict[str, Any]) -> tuple[float, float] | None:
    """A stable point for comparing the same feature in two datasets.

    The centroid rather than a representative point: a representative point can
    jump across a concave room for a hairline difference in the outline, which
    would swamp the offset being measured.
    """
    geometry = _candidate_geometry(feature)
    if not isinstance(geometry, dict):
        return None
    try:
        geom = shape(geometry)
    except Exception:
        return None
    if geom.is_empty:
        return None
    point = geom.centroid
    if point.is_empty:
        return None
    return (float(point.x), float(point.y))


def measure_alignment(session: SessionRecord, staged: StagedAppend) -> AppendAlignment | None:
    """Measure the gap between a batch and the dataset, on features common to both.

    Returns None when too few features appear in both to say anything. A
    measurement that comes back inconsistent is still returned, marked as such,
    because "these two datasets disagree in a way a shift will not fix" is worth
    saying rather than swallowing.
    """
    host_points: dict[str, tuple[float, float]] = {}
    for feature in _features_of(session.feature_collection):
        key = _normalised_id(feature.get("id"))
        if key is None or key in host_points:
            continue
        point = _anchor_point(feature)
        if point is not None:
            host_points[key] = point
    if not host_points:
        return None

    # Measured against the *source rows*, not the mapped features. The standard
    # profile mints a fresh UUID for everything it generates, so its features
    # share no ids with anything; the rows behind them still carry the id the
    # shapefile gave them, which is what the other dataset knows them by.
    incoming: list[tuple[str, dict[str, Any]]] = []
    for row in _features_of(staged.source_feature_collection):
        props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
        metadata = props.get("metadata") if isinstance(props.get("metadata"), dict) else {}
        key = _normalised_id(metadata.get("id"))
        if key is not None:
            incoming.append((key, row))
    if not incoming:
        incoming = [
            (key, feature)
            for feature in _features_of(staged.feature_collection)
            for key in [_normalised_id(feature.get("id"))]
            if key is not None
        ]

    deltas: list[tuple[float, float]] = []
    for key, feature in incoming:
        target = host_points.get(key)
        if target is None:
            continue
        point = _anchor_point(feature)
        if point is None:
            continue
        deltas.append((target[0] - point[0], target[1] - point[1]))

    if len(deltas) < MIN_ALIGNMENT_SAMPLES:
        return None

    offset_lon = statistics.median(delta[0] for delta in deltas)
    offset_lat = statistics.median(delta[1] for delta in deltas)
    latitude = host_points[next(iter(host_points))][1]
    lon_scale = METRES_PER_DEGREE_LON * math.cos(math.radians(latitude))

    east = offset_lon * lon_scale
    north = offset_lat * METRES_PER_DEGREE_LAT
    spread = max(
        math.hypot((delta[0] - offset_lon) * lon_scale, (delta[1] - offset_lat) * METRES_PER_DEGREE_LAT)
        for delta in deltas
    )

    return AppendAlignment(
        offset_lon=offset_lon,
        offset_lat=offset_lat,
        east_metres=east,
        north_metres=north,
        distance_metres=math.hypot(east, north),
        sample_count=len(deltas),
        spread_cm=spread * 100.0,
        consistent=spread * 100.0 <= ALIGNMENT_CONSISTENT_CM,
    )


def _shift_coordinates(value: Any, offset_lon: float, offset_lat: float) -> Any:
    """Shift a GeoJSON coordinate tree, whatever its nesting."""
    if isinstance(value, (list, tuple)):
        if len(value) >= 2 and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value[:2]):
            shifted = [value[0] + offset_lon, value[1] + offset_lat, *value[2:]]
            return shifted
        return [_shift_coordinates(item, offset_lon, offset_lat) for item in value]
    return value


def _shift_geometry(geometry: Any, offset_lon: float, offset_lat: float) -> Any:
    if not isinstance(geometry, dict):
        return geometry
    shifted = dict(geometry)
    if "coordinates" in shifted:
        shifted["coordinates"] = _shift_coordinates(shifted["coordinates"], offset_lon, offset_lat)
    if "geometries" in shifted and isinstance(shifted["geometries"], list):
        shifted["geometries"] = [_shift_geometry(item, offset_lon, offset_lat) for item in shifted["geometries"]]
    return shifted


def shift_features(features: list[dict[str, Any]], offset_lon: float, offset_lat: float) -> None:
    """Move features onto the dataset's frame, in place.

    Everything positional moves together: the geometry, the display point the
    review screen draws from, and the geometry the ODC importer stashes in
    metadata for the types that carry none of their own. Leaving any of them
    behind would put a feature and its own label in different places.
    """
    for feature in features:
        geometry = feature.get("geometry")
        if isinstance(geometry, dict):
            feature["geometry"] = _shift_geometry(geometry, offset_lon, offset_lat)
        props = feature.get("properties")
        if not isinstance(props, dict):
            continue
        display_point = props.get("display_point")
        if isinstance(display_point, dict):
            props["display_point"] = _shift_geometry(display_point, offset_lon, offset_lat)
        metadata = props.get("metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("__odc_geometry"), dict):
            metadata["__odc_geometry"] = _shift_geometry(metadata["__odc_geometry"], offset_lon, offset_lat)


# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------


def batches_dir(uploads_root: str | Path, session_id: str) -> Path:
    """Where staged batches live.

    Under the session's own upload directory, so ``SessionManager`` deletes them
    with the session, and ignored by the shapefile exporter, which only groups
    plain files in that directory.
    """
    return Path(uploads_root) / session_id / "batches"


def _staged_path(root: Path, batch_id: str) -> Path:
    return root / f"{batch_id}.json"


def _raw_dir(root: Path, batch_id: str) -> Path:
    return root / batch_id / "raw"


def _replaced_path(root: Path, batch_id: str) -> Path:
    return root / f"{batch_id}.replaced.json"


def stage_append(
    session: SessionRecord,
    file_blobs: list[tuple[str, bytes]],
    *,
    profile: str,
    uploads_root: str | Path,
    filename_keywords_path: str | Path,
    unit_categories_path: str | Path | None = None,
    prefer_filename_floor: bool = False,
) -> tuple[StagedAppend, AppendStageResponse]:
    """Read an upload against ``session`` without changing it."""
    if profile not in SUPPORTED_PROFILES:
        raise AppendError(f"Unsupported append profile '{profile}'.")
    if not file_blobs:
        raise AppendError("No files were uploaded.")
    if not _features_of(session.feature_collection):
        raise AppendError("This session has no features yet; import a dataset before appending to it.")

    if profile == "standard" and unit_categories_path is None:
        raise AppendError("The standard profile needs a unit category table.")

    batch_id = str(uuid4())
    if profile in SOURCE_LAYER_PROFILES:
        if profile == "imdf_shapefile":
            artifacts = import_imdf_shapefile_blobs(
                file_blobs,
                filename_keywords_path=filename_keywords_path,
                prefer_filename_floor=prefer_filename_floor,
            )
        else:
            artifacts = import_file_blobs(file_blobs, filename_keywords_path=filename_keywords_path)
        # Before the standard profile pays for a generation it may not keep.
        _reject_stem_collisions(session, [item.stem for item in artifacts.files], file_blobs)

        mappings: WizardMappingsState | None = None
        feature_collection = artifacts.feature_collection
        if profile == "standard":
            mappings = session.wizard.mappings.model_copy(deep=True)
            feature_collection = _build_standard_candidate(
                session,
                artifacts.files,
                artifacts.source_feature_collection,
                mappings,
                unit_categories_path,
            )
        staged = StagedAppend(
            batch_id=batch_id,
            session_id=session.session_id,
            profile=profile,
            files=artifacts.files,
            cleanup_summary=artifacts.cleanup_summary,
            feature_collection=feature_collection,
            source_feature_collection=artifacts.source_feature_collection,
            warnings=list(artifacts.warnings),
            mappings=mappings,
        )
    else:
        if len(file_blobs) != 1:
            raise AppendError("IMDF append expects exactly one .zip archive.")
        feature_collection = read_imdf_zip(file_blobs[0][1])
        staged = StagedAppend(
            batch_id=batch_id,
            session_id=session.session_id,
            profile=profile,
            files=[],
            cleanup_summary=CleanupSummary(),
            feature_collection=feature_collection,
            source_feature_collection={"type": "FeatureCollection", "features": []},
            warnings=[],
        )

    save_staged(uploads_root, staged)

    if profile in SOURCE_LAYER_PROFILES:
        raw = _raw_dir(batches_dir(uploads_root, session.session_id), batch_id)
        raw.mkdir(parents=True, exist_ok=True)
        for filename, payload in file_blobs:
            (raw / Path(filename).name).write_bytes(payload)

    return staged, plan_append(session, staged)


def restage_append(
    session: SessionRecord,
    staged: StagedAppend,
    *,
    files: list[AppendFileOverride] | None = None,
    mappings: WizardMappingsState | None = None,
    unit_categories_path: str | Path,
) -> tuple[StagedAppend, AppendStageResponse]:
    """Re-read an already-uploaded batch under corrected mapping choices.

    Generation mints fresh level ids, so the caller gets a new plan and any
    level decisions it was holding are re-derived from it rather than silently
    pointing at levels that no longer exist.
    """
    if staged.profile != "standard":
        raise AppendError("Only the standard profile maps attributes; this batch has nothing to re-map.")

    staged.files = _apply_file_overrides(staged.files, files or [])
    if mappings is not None:
        staged.mappings = mappings.model_copy(deep=True)
    staged.feature_collection = _build_standard_candidate(
        session,
        staged.files,
        staged.source_feature_collection,
        staged.mappings or WizardMappingsState(),
        unit_categories_path,
    )
    return staged, plan_append(session, staged)


def _reject_stem_collisions(
    session: SessionRecord,
    stems: list[str],
    file_blobs: list[tuple[str, bytes]],
) -> None:
    """Refuse an upload whose layer names are already in use by a *different* file.

    ``source_file`` plus ``source_row_index`` is the key the shapefile exporter
    writes rows back through, and the artifact directory holds one file per
    stem. Two different layers sharing a stem would cross-wire both. Renaming the
    incoming layer is not a safe repair either: the ODC layer type is read off
    the stem's trailing token and the floor off its first floor-shaped token, so
    a disambiguating suffix would change how the file is classified.

    The same file uploaded again is a different matter, and is allowed: it is
    how someone returns for rows they left out the first time. Rows already
    taken are skipped rather than duplicated (see ``_already_imported_rows``).
    """
    taken = {item.stem for item in session.files}
    clashing = sorted(set(stems) & taken)
    if not clashing:
        return

    artifact_dir = Path(session.upload_artifact_dir) if session.upload_artifact_dir else None
    incoming = {Path(name).name: payload for name, payload in file_blobs}
    conflicting = [stem for stem in clashing if not _same_layer_on_disk(artifact_dir, stem, incoming)]
    if conflicting:
        raise AppendError(
            "A different file is already in this session under "
            + ("these layer names: " if len(conflicting) > 1 else "this layer name: ")
            + ", ".join(conflicting)
            + ". Rename the incoming files, or remove the earlier import first. "
            "(Re-uploading the same file to pick up rows you left out is allowed.)"
        )

# The parts of a shapefile that say which layer it is. Comparing these is what
# lets a layer be uploaded a second time to pick up rows left behind, without
# letting a *different* file quietly take over the name the exports write back
# through.
LAYER_IDENTITY_EXTENSIONS = (".shp", ".dbf")


def _merge_added_files(existing: list[ImportedFile], added: list[ImportedFile]) -> list[ImportedFile]:
    """The file entries to record, skipping stems already there.

    Re-adding a layer to collect rows left behind must not record it twice: the
    entry already present describes the same file.
    """
    taken = {item.stem for item in existing}
    return [item for item in added if item.stem not in taken]


def _same_layer_on_disk(artifact_dir: Path | None, stem: str, incoming: dict[str, bytes]) -> bool:
    if artifact_dir is None or not artifact_dir.exists():
        return False
    for extension in LAYER_IDENTITY_EXTENSIONS:
        stored = artifact_dir / f"{stem}{extension}"
        payload = incoming.get(f"{stem}{extension}")
        if payload is None or not stored.exists() or stored.read_bytes() != payload:
            return False
    return True



def save_staged(uploads_root: str | Path, staged: StagedAppend) -> None:
    root = batches_dir(uploads_root, staged.session_id)
    root.mkdir(parents=True, exist_ok=True)
    _staged_path(root, staged.batch_id).write_text(json.dumps(staged.to_json()), encoding="utf-8")


def load_staged(uploads_root: str | Path, session_id: str, batch_id: str) -> StagedAppend:
    path = _staged_path(batches_dir(uploads_root, session_id), batch_id)
    if not path.exists():
        raise KeyError("Staged import not found")
    return StagedAppend.from_json(json.loads(path.read_text(encoding="utf-8")))


def discard_staged(uploads_root: str | Path, session_id: str, batch_id: str) -> None:
    root = batches_dir(uploads_root, session_id)
    _staged_path(root, batch_id).unlink(missing_ok=True)
    shutil.rmtree(root / batch_id, ignore_errors=True)


# ---------------------------------------------------------------------------
# Rebinding
# ---------------------------------------------------------------------------


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            output.append(value)
    return output


def _rewrite_references(feature: dict[str, Any], remap: dict[str, str]) -> None:
    props = feature.get("properties")
    if not isinstance(props, dict):
        return
    for key in REFERENCE_KEYS_SINGLE:
        value = props.get(key)
        if isinstance(value, str) and value in remap:
            props[key] = remap[value]
    for key in REFERENCE_KEYS_LIST:
        value = props.get(key)
        if isinstance(value, list):
            props[key] = _dedupe([remap.get(item, item) if isinstance(item, str) else item for item in value])
    metadata = props.get("metadata")
    if isinstance(metadata, dict):
        odc_level_id = metadata.get("__odc_level_id")
        if isinstance(odc_level_id, str) and odc_level_id in remap:
            metadata["__odc_level_id"] = remap[odc_level_id]


def _core_remap(
    host_features: list[dict[str, Any]],
    candidate_features: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, str]:
    """Point the batch's address/venue/building references at the host's own."""
    remap: dict[str, str] = {}
    for feature_type in HOST_OWNED_TYPES:
        host_ids = _ids_by_type(host_features, feature_type)
        candidate_ids = _ids_by_type(candidate_features, feature_type)
        if not host_ids or not candidate_ids:
            continue
        target = host_ids[0]
        if len(host_ids) > 1 or len(candidate_ids) > 1:
            warnings.append(
                f"Added features were attached to the first {feature_type} in this dataset "
                f"({len(candidate_ids)} incoming, {len(host_ids)} existing)."
            )
        for candidate_id in candidate_ids:
            remap[candidate_id] = target
    return remap


def _resolve_level_decisions(
    plan: AppendStageResponse,
    decisions: list[AppendLevelDecision],
    host_level_ids: set[str],
    levels_in_play: set[str] | None = None,
) -> tuple[dict[str, str], set[str], set[str]]:
    """Turn the caller's choices into bind / create / reject sets.

    A level that matched cleanly binds by default. One that did not needs an
    explicit answer: creating a floor and discarding a floor are both real edits
    to the dataset, and neither is a safe thing to pick on the user's behalf.
    """
    by_id = {item.candidate_level_id: item for item in decisions}
    known = {item.candidate_level_id for item in plan.levels}
    unknown = sorted(set(by_id) - known)
    if unknown:
        raise AppendError("Decisions reference levels that are not in this batch: " + ", ".join(unknown))

    level_remap: dict[str, str] = {}
    created: set[str] = set()
    rejected: set[str] = set()
    for match in plan.levels:
        decision = by_id.get(match.candidate_level_id)
        described = match.name or match.short_name or match.label or match.candidate_level_id
        if levels_in_play is not None and match.candidate_level_id not in levels_in_play:
            # Nothing selected from this floor, so it contributes nothing either
            # way; an answer about it would be answering about nothing.
            rejected.add(match.candidate_level_id)
            continue
        if decision is None:
            if match.host_level_id is None:
                raise AppendError(
                    f"Level '{described}' does not match an existing level. "
                    "Choose an existing level to add it to, create it as a new level, or leave it out."
                )
            level_remap[match.candidate_level_id] = match.host_level_id
            continue
        if decision.action == "reject":
            rejected.add(match.candidate_level_id)
        elif decision.action == "create":
            created.add(match.candidate_level_id)
        else:
            host_level_id = decision.host_level_id or match.host_level_id
            if host_level_id is None:
                raise AppendError(f"Level '{described}' was bound without naming an existing level.")
            if host_level_id not in host_level_ids:
                raise AppendError(f"Level '{described}' names an existing level that is not in this session.")
            level_remap[match.candidate_level_id] = host_level_id
    return level_remap, created, rejected


def commit_append(
    session: SessionRecord,
    staged: StagedAppend,
    *,
    decisions: list[AppendLevelDecision] | None = None,
    on_id_collision: str = "remint",
    selection: AppendSelection | None = None,
    apply_alignment: bool = False,
    expand_levels: bool = True,
) -> tuple[AppendCommitResponse, list[dict[str, Any]]]:
    """Merge a staged batch into ``session``.

    Returns the summary and the host features the batch replaced, which the
    caller persists so the append can be undone.
    """
    if on_id_collision not in ("remint", "replace"):
        raise AppendError(f"Unknown collision policy '{on_id_collision}'.")
    if any(item.batch_id == staged.batch_id for item in session.append_batches):
        raise AppendError("This import has already been added to the session.")

    plan = plan_append(session, staged)
    host_features = _features_of(session.feature_collection)
    host_level_ids = {item.id for item in _level_summaries(host_features)}

    # Which floors the selection actually touches. Resolved before the level
    # decisions because a floor nothing was selected from needs no answer — it
    # is not being imported, and demanding one for each of a station's
    # twenty-six is noise at best and a wall at worst.
    selected_ids, deselected, skipped_already_imported = select_feature_ids(session, staged, selection)
    levels_in_play = {
        level_id
        for feature in _features_of(staged.feature_collection)
        if str(feature.get("feature_type") or "") != "level"
        and str(feature.get("id")) in selected_ids
        for level_id in [_feature_level_id(feature)]
        if level_id
    }
    level_remap, created, rejected = _resolve_level_decisions(
        plan, decisions or [], host_level_ids, levels_in_play
    )

    warnings = list(staged.warnings)
    candidate_features = copy.deepcopy(_features_of(staged.feature_collection))

    alignment = plan.alignment if apply_alignment else None
    if alignment is not None:
        shift_features(candidate_features, alignment.offset_lon, alignment.offset_lat)
        warnings.append(
            f"Added features were shifted {alignment.distance_metres * 100:.0f} cm to line up with "
            "the data already here."
        )
    core_remap = _core_remap(host_features, candidate_features, warnings)

    # 1. Keep what the host does not already own, what the caller selected, and
    #    drop whatever hangs off a level they left out.
    kept: list[dict[str, Any]] = []
    dropped = 0
    for feature in candidate_features:
        feature_type = str(feature.get("feature_type") or "")
        feature_id = str(feature.get("id"))
        if feature_type in DROPPED_TYPES:
            dropped += 1
            continue
        if feature_type == "level":
            if feature_id in rejected or feature_id in level_remap:
                dropped += 1
                continue
        else:
            if feature_id not in selected_ids:
                continue
            level_id = _feature_level_id(feature)
            if isinstance(level_id, str) and level_id in rejected:
                dropped += 1
                continue
        kept.append(feature)

    # A floor the caller asked to create, whose features were all left out,
    # would arrive as an empty level. Drop it rather than adding a bare floor.
    populated_levels = {_feature_level_id(item) for item in kept if item.get("feature_type") != "level"}
    empty_created = {
        item for item in created if item not in populated_levels
    }
    if empty_created:
        created = created - empty_created
        kept = [item for item in kept if str(item.get("id")) not in empty_created]
        dropped += len(empty_created)

    # 2. Settle id collisions before rewriting anything, so references to a
    #    reminted feature follow it.
    host_ids = {str(feature.get("id")) for feature in host_features if feature.get("id") is not None}
    taken = set(host_ids)
    id_remap: dict[str, str] = {}
    replaced_ids: set[str] = set()
    reminted = 0
    for feature in kept:
        feature_id = str(feature.get("id"))
        if feature_id not in taken:
            taken.add(feature_id)
            continue
        if on_id_collision == "replace" and feature_id in host_ids and feature_id not in replaced_ids:
            replaced_ids.add(feature_id)
            continue
        new_id = str(uuid4())
        while new_id in taken:
            new_id = str(uuid4())
        id_remap[feature_id] = new_id
        feature["id"] = new_id
        taken.add(new_id)
        reminted += 1

    # 3. Rebind and tag.
    remap = {**core_remap, **level_remap, **id_remap}
    feature_counts: dict[str, int] = {}
    for feature in kept:
        _rewrite_references(feature, remap)
        props = feature.get("properties")
        if not isinstance(props, dict):
            props = {}
            feature["properties"] = props
        props[BATCH_PROPERTY] = staged.batch_id
        feature_type = str(feature.get("feature_type") or "")
        feature_counts[feature_type] = feature_counts.get(feature_type, 0) + 1

    # 4. Grow the floors that now hold something reaching past their edge.
    #    Apple rejects such a unit as an "Invalid level reference", which reads
    #    like a broken id rather than a floor plate that stops too soon.
    expanded_levels: list[str] = []
    if expand_levels:
        levels_by_id = {
            str(item.get("id")): item
            for item in host_features
            if item.get("feature_type") == "level" and isinstance(item.get("geometry"), dict)
        }
        additions_by_level: dict[str, list[Any]] = {}
        for feature in kept:
            if feature.get("feature_type") == "level":
                continue
            level_id = _feature_level_id(feature)
            geometry = _candidate_geometry(feature)
            if not isinstance(level_id, str) or not isinstance(geometry, dict):
                continue
            try:
                additions_by_level.setdefault(level_id, []).append(shape(geometry))
            except Exception:
                continue

        for level_id, additions in additions_by_level.items():
            level = levels_by_id.get(level_id)
            if level is None:
                continue
            try:
                base = shape(level["geometry"])
            except Exception:
                continue
            # Slivers on the boundary are inside; growing for those is noise.
            outside = [geom for geom in additions if not covers_within_tolerance(base, geom)]
            if not outside:
                continue
            grown = grow_to_cover(base, outside)
            if grown is None or grown.equals(base):
                continue
            level["geometry"] = mapping(grown)
            expanded_levels.append(level_id)
        if expanded_levels:
            warnings.append(
                f"{len(expanded_levels)} floor(s) were expanded to cover added features that "
                "reached past their edge."
            )

    replaced_features = [
        copy.deepcopy(feature)
        for feature in host_features
        if str(feature.get("id")) in replaced_ids
    ]
    remaining = [feature for feature in host_features if str(feature.get("id")) not in replaced_ids]

    session.feature_collection["type"] = "FeatureCollection"
    session.feature_collection["features"] = [*remaining, *kept]

    # 4. Source rows and file entries, without which the shapefile exports drop
    #    the added features as missing_source_linkage.
    # Only the rows that actually came in are recorded, so re-adding the layer
    # later can tell what is still outstanding.
    kept_rows = {
        (props.get("source_file"), props.get("source_row_index"))
        for props in (item.get("properties") for item in kept)
        if isinstance(props, dict)
    }
    source_rows = [
        copy.deepcopy(row)
        for row in _features_of(staged.source_feature_collection)
        if isinstance(row.get("properties"), dict)
        and (row["properties"].get("source_file"), row["properties"].get("source_row_index")) in kept_rows
    ]
    if alignment is not None:
        shift_features(source_rows, alignment.offset_lon, alignment.offset_lat)
    for row in source_rows:
        props = row.get("properties")
        if isinstance(props, dict):
            props[BATCH_PROPERTY] = staged.batch_id
    if source_rows:
        if not isinstance(session.source_feature_collection, dict):
            session.source_feature_collection = {"type": "FeatureCollection", "features": []}
        existing_rows = _features_of(session.source_feature_collection)
        session.source_feature_collection["type"] = "FeatureCollection"
        session.source_feature_collection["features"] = [*existing_rows, *source_rows]

    # A layer that contributed nothing must not claim a stem, or re-adding it
    # later would be refused as a duplicate.
    contributing_stems = {
        props.get("source_file")
        for props in (item.get("properties") for item in kept)
        if isinstance(props, dict)
    }
    added_files = [item for item in staged.files if item.stem in contributing_stems]
    new_file_entries = _merge_added_files(session.files, added_files)
    session.files = [*session.files, *new_file_entries]
    _merge_cleanup_summary(session.cleanup_summary, staged.cleanup_summary)
    session.warnings = [*session.warnings, *staged.warnings]
    # The stored verdict describes the dataset as it was before the append.
    session.validation = None
    if alignment is not None and session.coordinate_alignment is None:
        session.coordinate_alignment = alignment.model_copy(update={"from_session": True})
    session.append_batches = [
        *session.append_batches,
        AppendBatchSummary(
            batch_id=staged.batch_id,
            profile=staged.profile,
            committed_at=datetime.now(UTC),
            file_stems=[item.stem for item in new_file_entries],
            feature_count=len(kept),
            created_level_ids=sorted(id_remap.get(item, item) for item in created),
            warnings=warnings,
        ),
    ]

    return (
        AppendCommitResponse(
            session_id=session.session_id,
            batch_id=staged.batch_id,
            added_features=len(kept),
            feature_counts=feature_counts,
            bound_levels=level_remap,
            created_level_ids=sorted(id_remap.get(item, item) for item in created),
            rejected_level_ids=sorted(rejected),
            dropped_features=dropped,
            alignment_applied=alignment,
            expanded_level_ids=sorted(set(expanded_levels)),
            deselected_features=deselected,
            skipped_already_imported=skipped_already_imported,
            reminted_ids=reminted,
            replaced_ids=len(replaced_ids),
            total_features=len(_features_of(session.feature_collection)),
            warnings=warnings,
        ),
        replaced_features,
    )


def _merge_cleanup_summary(target: CleanupSummary, addition: CleanupSummary) -> None:
    target.multipolygons_exploded += addition.multipolygons_exploded
    target.rings_closed += addition.rings_closed
    target.features_reoriented += addition.features_reoriented
    target.empty_features_dropped += addition.empty_features_dropped
    target.coordinates_rounded += addition.coordinates_rounded
    room = DROPPED_ROWS_SAMPLE_LIMIT - len(target.dropped_rows)
    if room > 0:
        target.dropped_rows.extend(addition.dropped_rows[:room])


# ---------------------------------------------------------------------------
# Undo
# ---------------------------------------------------------------------------


def undo_append(
    session: SessionRecord,
    batch_id: str,
    *,
    replaced_features: list[dict[str, Any]] | None = None,
) -> AppendUndoResponse:
    """Take a committed batch back out, restoring anything it replaced."""
    summary = next((item for item in session.append_batches if item.batch_id == batch_id), None)
    if summary is None:
        raise KeyError("Import batch not found")

    def _batch_of(feature: dict[str, Any]) -> str | None:
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        value = props.get(BATCH_PROPERTY)
        return value if isinstance(value, str) else None

    features = _features_of(session.feature_collection)
    kept_features = [feature for feature in features if _batch_of(feature) != batch_id]
    removed_features = len(features) - len(kept_features)
    session.feature_collection["features"] = [*kept_features, *copy.deepcopy(replaced_features or [])]

    source_rows = _features_of(session.source_feature_collection)
    kept_rows = [row for row in source_rows if _batch_of(row) != batch_id]
    removed_rows = len(source_rows) - len(kept_rows)
    if isinstance(session.source_feature_collection, dict):
        session.source_feature_collection["features"] = kept_rows

    stems = set(summary.file_stems)
    session.files = [item for item in session.files if item.stem not in stems]
    session.append_batches = [item for item in session.append_batches if item.batch_id != batch_id]
    session.validation = None

    return AppendUndoResponse(
        session_id=session.session_id,
        batch_id=batch_id,
        removed_features=removed_features,
        removed_source_rows=removed_rows,
        removed_files=sorted(stems),
        total_features=len(_features_of(session.feature_collection)),
    )


# ---------------------------------------------------------------------------
# Upload artifacts
# ---------------------------------------------------------------------------


def save_replaced(uploads_root: str | Path, session_id: str, batch_id: str, features: list[dict[str, Any]]) -> None:
    if not features:
        return
    root = batches_dir(uploads_root, session_id)
    root.mkdir(parents=True, exist_ok=True)
    _replaced_path(root, batch_id).write_text(json.dumps(features), encoding="utf-8")


def load_replaced(uploads_root: str | Path, session_id: str, batch_id: str) -> list[dict[str, Any]]:
    path = _replaced_path(batches_dir(uploads_root, session_id), batch_id)
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, list) else []


def promote_batch_artifacts(uploads_root: str | Path, session: SessionRecord, batch_id: str) -> str | None:
    """Move a committed batch's shapefiles in beside the session's own.

    The roundtrip and ODC exports rewrite rows in the files that were uploaded,
    read straight out of this directory, so added layers have to land here or
    they exist only in the review screen.
    """
    raw = _raw_dir(batches_dir(uploads_root, session.session_id), batch_id)
    if not raw.exists():
        return session.upload_artifact_dir

    target = Path(session.upload_artifact_dir) if session.upload_artifact_dir else Path(uploads_root) / session.session_id
    target.mkdir(parents=True, exist_ok=True)
    for entry in sorted(raw.iterdir()):
        if entry.is_file():
            shutil.copy2(entry, target / entry.name)
    return str(target)


def remove_batch_artifacts(session: SessionRecord, stems: list[str]) -> None:
    if not session.upload_artifact_dir or not stems:
        return
    directory = Path(session.upload_artifact_dir)
    if not directory.exists():
        return
    wanted = set(stems)
    for entry in directory.iterdir():
        if entry.is_file() and entry.stem in wanted:
            entry.unlink(missing_ok=True)
