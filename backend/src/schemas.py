"""Pydantic API schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DroppedRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_file: str
    row_index: int
    id: str | None = None
    reason: str


class CleanupSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    multipolygons_exploded: int = 0
    rings_closed: int = 0
    features_reoriented: int = 0
    empty_features_dropped: int = 0
    coordinates_rounded: int = 0
    # Bounded sample of dropped-row identities. Counts above stay authoritative.
    dropped_rows: list[DroppedRow] = Field(default_factory=list)


class IsoSubdivision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    name: str


class IsoSubdivisionsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    country: str
    subdivisions: list[IsoSubdivision] = Field(default_factory=list)


class ImportedFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stem: str
    geometry_type: str
    feature_count: int
    attribute_columns: list[str]
    source_format: Literal["shapefile", "gpkg"] = "shapefile"
    source_layer: str | None = None
    detected_type: str | None = None
    detected_level: int | None = None
    level_name: str | None = None
    short_name: str | None = None
    outdoor: bool = False
    level_category: str = "unspecified"
    confidence: str = "red"
    crs_detected: str | None = None
    warnings: list[str] = Field(default_factory=list)


class ImportResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    import_profile: Literal["standard", "imdf_shapefile"] = "standard"
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    warnings: list[str] = Field(default_factory=list)


class FeatureCollectionResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str
    features: list[dict[str, Any]]


class AddressInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    address: str | None = None
    unit: str | None = None
    locality: str
    province: str | None = None
    country: str
    postal_code: str | None = None
    postal_code_ext: str | None = None
    postal_code_vanity: str | None = None


class ProjectWizardState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_name: str | None = None
    venue_name: str
    venue_category: str
    language: str = "en"
    venue_restriction: str | None = None
    venue_hours: str | None = None
    venue_phone: str | None = None
    venue_website: str | None = None
    address: AddressInput


class LevelWizardItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stem: str
    detected_type: str | None = None
    ordinal: int | None = None
    name: str | None = None
    short_name: str | None = None
    outdoor: bool = False
    category: str = "unspecified"


class LevelsWizardState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[LevelWizardItem] = Field(default_factory=list)


class BuildingWizardState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str | None = None
    category: str = "unspecified"
    restriction: str | None = None
    file_stems: list[str] = Field(default_factory=list)
    address_mode: Literal["same_as_venue", "different_address"] = "same_as_venue"
    address: AddressInput | None = None
    address_feature_id: str | None = None


class UnitCodePreviewRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    count: int
    resolved_category: str
    unresolved: bool


class UnitMappingState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code_column: str | None = None
    name_column: str | None = None
    alt_name_column: str | None = None
    restriction_column: str | None = None
    accessibility_column: str | None = None
    available_categories: list[str] = Field(default_factory=list)
    preview: list[UnitCodePreviewRow] = Field(default_factory=list)


class OpeningMappingState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category_column: str | None = None
    accessibility_column: str | None = None
    access_control_column: str | None = None
    door_automatic_column: str | None = None
    door_material_column: str | None = None
    door_type_column: str | None = None
    name_column: str | None = None


class FixtureMappingState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name_column: str | None = None
    alt_name_column: str | None = None
    category_column: str | None = None


class WizardMappingsState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    unit: UnitMappingState = Field(default_factory=UnitMappingState)
    opening: OpeningMappingState = Field(default_factory=OpeningMappingState)
    fixture: FixtureMappingState = Field(default_factory=FixtureMappingState)
    detail_confirmed: bool = False


class FootprintWizardState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Literal["union_buffer", "convex_hull", "concave_hull"] = "union_buffer"
    footprint_buffer_m: float = 0.0
    venue_buffer_m: float = 0.0
    level_gap_fill_m: float = 0.1


class WizardState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project: ProjectWizardState | None = None
    levels: LevelsWizardState = Field(default_factory=LevelsWizardState)
    buildings: list[BuildingWizardState] = Field(default_factory=list)
    mappings: WizardMappingsState = Field(default_factory=WizardMappingsState)
    footprint: FootprintWizardState = Field(default_factory=FootprintWizardState)
    company_mappings: dict[str, str] = Field(default_factory=dict)
    company_default_category: str = "unspecified"
    venue_address_feature: dict[str, Any] | None = None
    building_address_features: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    generation_status: Literal["not_started", "draft_ready", "generated"] = "not_started"


class ValidationIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_id: str | None = None
    related_feature_id: str | None = None
    check: str
    message: str
    severity: Literal["error", "warning"]
    auto_fixable: bool = False
    fix_description: str | None = None
    overlap_geometry: dict[str, Any] | None = None
    snap_candidates: list[str] = Field(default_factory=list)


class ValidationSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_features: int = 0
    by_type: dict[str, int] = Field(default_factory=dict)
    error_count: int = 0
    warning_count: int = 0
    auto_fixable_count: int = 0
    checks_passed: int = 0
    checks_failed: int = 0
    unspecified_count: int = 0
    overlap_count: int = 0
    opening_issues_count: int = 0


class ValidationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    errors: list[ValidationIssue] = Field(default_factory=list)
    warnings: list[ValidationIssue] = Field(default_factory=list)
    passed: list[str] = Field(default_factory=list)
    summary: ValidationSummary = Field(default_factory=ValidationSummary)


class AutofixRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    apply_prompted: bool = False


class AutofixApplied(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_id: str | None = None
    related_feature_id: str | None = None
    check: str
    action: str
    description: str


class AutofixPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_id: str | None = None
    related_feature_id: str | None = None
    check: str
    action: str
    description: str
    requires_confirmation: bool = True


class AutofixResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fixes_applied: list[AutofixApplied] = Field(default_factory=list)
    fixes_requiring_confirmation: list[AutofixPrompt] = Field(default_factory=list)
    total_fixed: int = 0
    total_requiring_confirmation: int = 0
    revalidation: ValidationResponse


class AppendHostLevel(BaseModel):
    """A level already in the session, offered as an append target."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str | None = None
    short_name: str | None = None
    ordinal: int | None = None
    label: str | None = None


class AppendLevelMatch(BaseModel):
    """How one level in the staged batch lines up against the session's levels."""

    model_config = ConfigDict(extra="forbid")

    candidate_level_id: str
    name: str | None = None
    short_name: str | None = None
    ordinal: int | None = None
    label: str | None = None
    feature_count: int = 0
    match_basis: Literal["name", "floor_label", "ordinal", "ambiguous", "unmatched"]
    host_level_id: str | None = None
    host_level_options: list[AppendHostLevel] = Field(default_factory=list)


class AppendFileSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stem: str
    geometry_type: str
    feature_count: int
    detected_type: str | None = None
    detected_level: int | None = None
    level_name: str | None = None
    short_name: str | None = None
    outdoor: bool = False
    level_category: str = "unspecified"
    confidence: str = "red"
    source_format: Literal["shapefile", "gpkg"] = "shapefile"
    attribute_columns: list[str] = Field(default_factory=list)
    # What the .prj declared. Null means none was found, and the coordinates
    # were taken as WGS84 degrees already — which for a projected layer puts
    # them off the map entirely.
    crs_detected: str | None = None
    warnings: list[str] = Field(default_factory=list)


class AppendFileOverride(BaseModel):
    """Per-file corrections to a staged batch, mirroring the wizard's level step."""

    model_config = ConfigDict(extra="forbid")

    stem: str
    detected_type: str | None = None
    detected_level: int | None = None
    level_name: str | None = None
    short_name: str | None = None
    outdoor: bool | None = None
    level_category: str | None = None


class AppendRestageRequest(BaseModel):
    """Re-read a staged batch under different mapping choices.

    Regenerating mints new ids for the batch's levels, so the caller gets a
    fresh plan back and any level decisions it had made are re-derived from it.
    """

    model_config = ConfigDict(extra="forbid")

    files: list[AppendFileOverride] = Field(default_factory=list)
    mappings: WizardMappingsState | None = None


class AppendStageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    batch_id: str
    profile: Literal["imdf_shapefile", "imdf", "standard"]
    files: list[AppendFileSummary] = Field(default_factory=list)
    levels: list[AppendLevelMatch] = Field(default_factory=list)
    host_levels: list[AppendHostLevel] = Field(default_factory=list)
    feature_counts: dict[str, int] = Field(default_factory=dict)
    id_collisions: int = 0
    id_collision_sample: list[str] = Field(default_factory=list)
    needs_decisions: bool = False
    needs_mapping: bool = False
    alignment: AppendAlignment | None = None
    mappings: WizardMappingsState | None = None
    cleanup_summary: CleanupSummary = Field(default_factory=CleanupSummary)
    warnings: list[str] = Field(default_factory=list)


class AppendLevelDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_level_id: str
    action: Literal["bind", "create", "reject"]
    host_level_id: str | None = None


class AppendAlignment(BaseModel):
    """A constant offset between an incoming batch and the dataset it joins.

    Two producers can both be "WGS84" and disagree by most of a metre: PROJ
    treats JGD2011 as identical to WGS84, while an epoch-aware pipeline shifts
    by however far the plate has moved since. Rather than guess which is meant,
    the gap is measured on features that appear in both, keyed by id.
    """

    model_config = ConfigDict(extra="forbid")

    offset_lon: float
    offset_lat: float
    east_metres: float
    north_metres: float
    distance_metres: float
    sample_count: int
    # Largest deviation from the median, in centimetres. A constant datum shift
    # is consistent to a few millimetres; anything loose means the two datasets
    # genuinely differ and a blanket shift would be wrong.
    spread_cm: float
    consistent: bool
    # True when it came from an earlier append rather than this batch.
    from_session: bool = False


class AppendLayerSelection(BaseModel):
    """What to keep from one incoming layer."""

    model_config = ConfigDict(extra="forbid")

    stem: str
    included: bool = True
    # Keep only rows whose ``filter_column`` value is one of ``filter_values``.
    # A null column means the layer is unfiltered.
    filter_column: str | None = None
    filter_values: list[str] = Field(default_factory=list)


class AppendSelection(BaseModel):
    """Which of a staged batch's features to actually bring in.

    The three ways of choosing compose into one rule: a feature is kept when it
    passes every active filter, then the two deviation lists apply on top so
    ticking a row back on or off does not mean rewriting the filters. Sent
    declaratively and evaluated on the server, so what the preview draws can
    never be what decides — the same split the Illustrator floor assignment uses.
    """

    model_config = ConfigDict(extra="forbid")

    # Where the selection starts before the deviation lists apply. "filters"
    # takes everything the filters match; "picked" takes nothing until it is
    # named in ``included_feature_ids``.
    base: Literal["filters", "picked"] = "filters"
    layers: list[AppendLayerSelection] = Field(default_factory=list)
    feature_types: list[str] | None = None
    # Candidate level ids; null means every floor.
    level_ids: list[str] | None = None
    # Resolved IMDF categories; null means every category.
    categories: list[str] | None = None
    # WGS84 minx, miny, maxx, maxy. Membership is centroid-in-box.
    bbox: tuple[float, float, float, float] | None = None
    excluded_feature_ids: list[str] = Field(default_factory=list)
    included_feature_ids: list[str] = Field(default_factory=list)


class AppendCandidateFeature(BaseModel):
    """One incoming feature, flattened for the selection UI."""

    model_config = ConfigDict(extra="forbid")

    id: str
    feature_type: str
    stem: str | None = None
    source_row_index: int | None = None
    name: str | None = None
    category: str | None = None
    level_id: str | None = None
    level_label: str | None = None
    # [longitude, latitude] of the representative point, for the map picker.
    point: tuple[float, float] | None = None
    # The shape itself, so the picker draws the plan rather than a cloud of dots.
    geometry: dict[str, Any] | None = None
    attributes: dict[str, str] = Field(default_factory=dict)
    already_imported: bool = False


class AppendCandidateFeaturesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    batch_id: str
    features: list[AppendCandidateFeature] = Field(default_factory=list)
    columns_by_stem: dict[str, list[str]] = Field(default_factory=dict)


class AppendSelectionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selected: int = 0
    total: int = 0
    by_type: dict[str, int] = Field(default_factory=dict)
    skipped_already_imported: int = 0


class AppendCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_id: str
    level_decisions: list[AppendLevelDecision] = Field(default_factory=list)
    on_id_collision: Literal["remint", "replace"] = "remint"
    # Omitted means everything in the batch.
    selection: AppendSelection | None = None
    # Shift the batch onto the dataset's frame before adding it.
    apply_alignment: bool = False
    # Grow a floor when what lands on it reaches past its edge.
    expand_levels: bool = True


class AppendBatchSummary(BaseModel):
    """Committed batch, kept on the session so the append can be undone."""

    model_config = ConfigDict(extra="forbid")

    batch_id: str
    profile: Literal["imdf_shapefile", "imdf", "standard"]
    committed_at: datetime
    file_stems: list[str] = Field(default_factory=list)
    feature_count: int = 0
    created_level_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class AppendCommitResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    batch_id: str
    added_features: int = 0
    feature_counts: dict[str, int] = Field(default_factory=dict)
    bound_levels: dict[str, str] = Field(default_factory=dict)
    created_level_ids: list[str] = Field(default_factory=list)
    rejected_level_ids: list[str] = Field(default_factory=list)
    dropped_features: int = 0
    alignment_applied: AppendAlignment | None = None
    # Floors grown so an added feature reaching past the edge still fits.
    expanded_level_ids: list[str] = Field(default_factory=list)
    deselected_features: int = 0
    skipped_already_imported: int = 0
    reminted_ids: int = 0
    replaced_ids: int = 0
    total_features: int = 0
    warnings: list[str] = Field(default_factory=list)


class AppendUndoResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    batch_id: str
    removed_features: int = 0
    removed_source_rows: int = 0
    removed_files: list[str] = Field(default_factory=list)
    total_features: int = 0

class SessionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    import_profile: Literal["standard", "imdf_shapefile"] = "standard"
    created_at: datetime
    last_accessed: datetime
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    feature_collection: dict[str, Any]
    source_feature_collection: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    learned_keywords: dict[str, str] = Field(default_factory=dict)
    upload_artifact_dir: str | None = None
    wizard: WizardState = Field(default_factory=WizardState)
    validation: ValidationResponse | None = None
    append_batches: list[AppendBatchSummary] = Field(default_factory=list)
    # Measured once and kept, so a later batch with no overlapping ids can still
    # be put on the same frame.
    coordinate_alignment: AppendAlignment | None = None


class DetectResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    files: list[ImportedFile]


class UpdateFileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detected_type: str | None = None
    detected_level: int | None = None
    level_name: str | None = None
    short_name: str | None = None
    outdoor: bool | None = None
    level_category: str | None = None
    apply_learning: bool = False
    learning_keyword: str | None = None


class LearningSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_stem: str
    keyword: str
    feature_type: str
    affected_stems: list[str]
    message: str


class UpdateFileResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    file: ImportedFile
    files: list[ImportedFile]
    save_status: Literal["saved"] = "saved"
    learning_suggestion: LearningSuggestion | None = None


class WizardStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    wizard: WizardState


class ProjectWizardRequest(ProjectWizardState):
    pass


class ProjectWizardResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    wizard: WizardState
    address_feature: dict[str, Any]


class GeocodeAddressInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    address: str | None = None
    unit: str | None = None
    locality: str | None = None
    province: str | None = None
    country: str | None = None
    postal_code: str | None = None
    postal_code_ext: str | None = None
    postal_code_vanity: str | None = None


class GeocodeResultItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str
    latitude: float
    longitude: float
    source: str = "nominatim"
    address: GeocodeAddressInput = Field(default_factory=GeocodeAddressInput)


class AddressSearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    query: str
    language: str
    results: list[GeocodeResultItem] = Field(default_factory=list)


class AddressAutofillResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    language: str
    source_point: list[float] | None = None
    result: GeocodeResultItem | None = None
    warnings: list[str] = Field(default_factory=list)


class LevelsWizardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[LevelWizardItem] = Field(default_factory=list)


class BuildingsWizardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    buildings: list[BuildingWizardState] = Field(default_factory=list)


class BuildingsWizardResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    wizard: WizardState
    address_features: list[dict[str, Any]]


class MappingsWizardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    unit: UnitMappingState | None = None
    opening: OpeningMappingState | None = None
    fixture: FixtureMappingState | None = None
    detail_confirmed: bool | None = None
    unit_category_overrides: dict[str, str] | None = None


class FootprintWizardRequest(FootprintWizardState):
    pass


class CompanyMappingsUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    default_category: str
    mappings_count: int
    preview: list[UnitCodePreviewRow] = Field(default_factory=list)
    unresolved_count: int = 0


class GenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    status: Literal["draft", "generated"]
    generated_feature_count: int
    message: str


class ShapefileExportUnitOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    write_imdf_category: bool = True
    imdf_category_field: str = "IMDF_CAT"
    overwrite_legacy_code_field: str | None = None
    legacy_code_map: dict[str, str] = Field(default_factory=dict)


class ShapefileExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile: Literal["imdf_roundtrip", "odc2026"] = "imdf_roundtrip"
    mode: Literal["source_update"] = "source_update"
    encoding: Literal["preserve_source", "utf-8", "cp932"] = "preserve_source"
    unit: ShapefileExportUnitOptions = Field(default_factory=ShapefileExportUnitOptions)
    include_report: bool = True
    export_name: str | None = None


class FeatureResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str
    id: str
    feature_type: str
    geometry: dict[str, Any] | None
    properties: dict[str, Any]


class PatchFeatureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    properties: dict[str, Any] | None = None
    geometry: dict[str, Any] | None = None


class BulkPatchFeaturesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_ids: list[str] = Field(default_factory=list)
    properties: dict[str, Any] | None = None
    action: Literal["patch", "delete", "merge_units"] = "patch"
    merge_name: str | None = None


class BulkPatchFeaturesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    updated_count: int = 0
    deleted_count: int = 0
    merged_feature_id: str | None = None


class ResolveUnitOverlapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keep_feature_id: str
    clip_feature_id: str


class ResolveUnitOverlapsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    resolved_pairs: int = 0
    updated_count: int = 0
    deleted_count: int = 0
    skipped_count: int = 0
    validation: ValidationResponse


class ImportImdfResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    feature_count: int


class SnapOpeningRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    opening_id: str
    unit_id: str


class SnapOpeningResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    validation: ValidationResponse


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str
    code: str


class TransformPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artwork_anchor: list[float] = Field(min_length=2, max_length=2)
    map_anchor: list[float] = Field(min_length=2, max_length=2)
    rotation_deg: float = 0.0
    metres_per_point: float = Field(gt=0)
    working_crs: str


class ExportFormatsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    geopackage: bool = True
    shapefile: bool = True
    qgis: bool = True


class IllustratorExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floors: list[FloorExportPayload] = Field(min_length=1)
    output_crs: str = "EPSG:4326"
    formats: ExportFormatsPayload = Field(default_factory=ExportFormatsPayload)


class IllustratorLayerSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    ai_layer: str
    role: str
    feature_count: int


class IllustratorPagePreview(BaseModel):
    """One page of the source document, for the floor-assignment grid."""

    model_config = ConfigDict(extra="forbid")

    index: int
    bounds: list[float] = Field(min_length=4, max_length=4)
    width_pt: float
    height_pt: float
    feature_count: int
    preview_feature_count: int


class IllustratorPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversion_id: str
    report: dict[str, Any]
    layers: list[IllustratorLayerSummary] = Field(default_factory=list)
    pages: list[IllustratorPagePreview] = Field(default_factory=list)
    artwork_bounds: list[float]
    preview: dict[str, Any]
    preview_features: int
    total_features: int
    suggested_crs: str
    suggested_crs_label: str


class GeocodeSearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    language: str
    results: list[GeocodeResultItem] = Field(default_factory=list)


class PlacementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    floors: list[FloorExportPayload] = Field(min_length=1)
    artwork_bounds: list[float] = Field(min_length=4, max_length=4)


class PlacementItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    floors: list[FloorExportPayload]
    artwork_bounds: list[float]
    created_at: str
    updated_at: str


class PlacementListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    placements: list[PlacementItem] = Field(default_factory=list)


_ArtworkBox = Annotated[list[float], Field(min_length=4, max_length=4)]


class FloorRegionPayload(BaseModel):
    """One floor's filters in artwork space; ``None`` means "no restriction"."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=40)
    box: _ArtworkBox | None = None
    pages: list[int] | None = None
    layer_names: list[str] | None = None


class AssignFloorsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floors: list[FloorRegionPayload] = Field(min_length=1)


class AssignLayerCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    ai_layer: str
    count: int


class AssignFloorSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    feature_count: int
    artwork_bounds: list[float]
    layer_counts: list[AssignLayerCount] = Field(default_factory=list)


class AssignFloorsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floors: list[AssignFloorSummary] = Field(default_factory=list)
    unassigned_count: int
    total_features: int


class ReferenceLayerItem(BaseModel):
    """A shapefile/GeoPackage layer served as WGS84 GeoJSON for map display."""

    model_config = ConfigDict(extra="forbid")

    name: str
    crs: str | None = None
    feature_count: int
    truncated: bool = False
    warnings: list[str] = Field(default_factory=list)
    geojson: dict[str, Any]


class ReferenceLayersResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    layers: list[ReferenceLayerItem] = Field(default_factory=list)


class FloorExportPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    transform: TransformPayload
