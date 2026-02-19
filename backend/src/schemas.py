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


class ImportedFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stem: str
    geometry_type: str
    feature_count: int
    attribute_columns: list[str]
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
    footprint_buffer_m: float = 0.5
    venue_buffer_m: float = 5.0


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


class SessionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    created_at: datetime
    last_accessed: datetime
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    feature_collection: dict[str, Any]
    source_feature_collection: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    learned_keywords: dict[str, str] = Field(default_factory=dict)
    wizard: WizardState = Field(default_factory=WizardState)


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


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str
    code: str
