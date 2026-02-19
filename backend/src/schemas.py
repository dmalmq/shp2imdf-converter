"""Pydantic API schemas."""

from __future__ import annotations

from datetime import datetime
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


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str
    code: str

