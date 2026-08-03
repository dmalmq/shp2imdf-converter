"""Pydantic API schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CleanupSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    multipolygons_exploded: int = 0
    rings_closed: int = 0
    features_reoriented: int = 0
    empty_features_dropped: int = 0
    coordinates_rounded: int = 0


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


class IllustratorPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversion_id: str
    report: dict[str, Any]
    layers: list[IllustratorLayerSummary] = Field(default_factory=list)
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


class FloorRegionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=40)
    box: list[float] = Field(min_length=4, max_length=4)
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


class FloorExportPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    transform: TransformPayload
