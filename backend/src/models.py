"""Domain dataclasses for IMDF feature structures."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


Labels = dict[str, str]
DisplayPoint = dict[str, Any]
Door = dict[str, Any]


@dataclass(slots=True)
class AddressProperties:
    address: str
    locality: str
    country: str
    unit: str | None = None
    province: str | None = None
    postal_code: str | None = None
    postal_code_ext: str | None = None
    postal_code_vanity: str | None = None


@dataclass(slots=True)
class VenueProperties:
    category: str
    name: Labels
    display_point: DisplayPoint
    address_id: str
    restriction: str | None = None
    alt_name: Labels | None = None
    hours: str | None = None
    phone: str | None = None
    website: str | None = None


@dataclass(slots=True)
class BuildingProperties:
    category: str
    name: Labels | None = None
    alt_name: Labels | None = None
    restriction: str | None = None
    display_point: DisplayPoint | None = None
    address_id: str | None = None


@dataclass(slots=True)
class FootprintProperties:
    category: str
    building_ids: list[str]
    name: Labels | None = None


@dataclass(slots=True)
class LevelProperties:
    category: str
    outdoor: bool
    ordinal: int
    name: Labels
    short_name: Labels
    restriction: str | None = None
    display_point: DisplayPoint | None = None
    address_id: str | None = None
    building_ids: list[str] | None = None


@dataclass(slots=True)
class UnitProperties:
    category: str
    level_id: str
    restriction: str | None = None
    accessibility: list[str] | None = None
    name: Labels | None = None
    alt_name: Labels | None = None
    display_point: DisplayPoint | None = None


@dataclass(slots=True)
class OpeningProperties:
    category: str
    level_id: str
    accessibility: list[str] | None = None
    access_control: list[str] | None = None
    door: Door | None = None
    name: Labels | None = None
    alt_name: Labels | None = None
    display_point: DisplayPoint | None = None


@dataclass(slots=True)
class FixtureProperties:
    category: str
    level_id: str
    name: Labels | None = None
    alt_name: Labels | None = None
    anchor_id: str | None = None
    display_point: DisplayPoint | None = None


@dataclass(slots=True)
class DetailProperties:
    level_id: str


@dataclass(slots=True)
class ImdfFeature:
    id: str
    feature_type: str
    geometry: dict[str, Any] | None
    properties: dict[str, Any]
    type: str = "Feature"

