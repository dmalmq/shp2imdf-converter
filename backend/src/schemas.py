"""Pydantic API schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from typing import Any

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


class SessionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    created_at: datetime
    last_accessed: datetime
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    feature_collection: dict[str, Any]
    warnings: list[str] = Field(default_factory=list)
    learned_keywords: dict[str, str] = Field(default_factory=dict)


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


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str
    code: str
