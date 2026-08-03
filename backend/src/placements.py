"""Named placements, so the floors of one building are positioned once.

SQLite rather than a JSON file: this runs on a shared PC, and a
read-modify-write over JSON silently loses one of two concurrent saves.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# A saved placement is anchored on the artboard it was authored against; warn if
# the new drawing differs by more than this fraction in width or height.
_BOUNDS_TOLERANCE = 0.01

_SCHEMA = """
CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  floors TEXT NOT NULL,
  artwork_bounds TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


class DuplicatePlacementError(Exception):
    """Raised when a placement name is already taken."""


class PlacementNotFoundError(KeyError):
    """Raised when a placement id does not exist."""


@dataclass(slots=True)
class Placement:
    id: int
    name: str
    floors: list[dict]
    artwork_bounds: list[float]
    created_at: str
    updated_at: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PlacementStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10, isolation_level="IMMEDIATE")
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _to_placement(row: sqlite3.Row) -> Placement:
        return Placement(
            id=row["id"],
            name=row["name"],
            floors=json.loads(row["floors"]),
            artwork_bounds=json.loads(row["artwork_bounds"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_all(self) -> list[Placement]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM placements ORDER BY name").fetchall()
        return [self._to_placement(row) for row in rows]

    def create(self, name: str, floors: list[dict], artwork_bounds: list[float]) -> Placement:
        stamp = _now()
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    "INSERT INTO placements (name, floors, artwork_bounds, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (name.strip(), json.dumps(floors), json.dumps(artwork_bounds), stamp, stamp),
                )
                row = connection.execute(
                    "SELECT * FROM placements WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
        except sqlite3.IntegrityError as exc:
            raise DuplicatePlacementError(f"A placement named '{name}' already exists.") from exc
        return self._to_placement(row)

    def update(
        self, placement_id: int, name: str, floors: list[dict], artwork_bounds: list[float]
    ) -> Placement:
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    "UPDATE placements SET name = ?, floors = ?, artwork_bounds = ?,"
                    " updated_at = ? WHERE id = ?",
                    (name.strip(), json.dumps(floors), json.dumps(artwork_bounds), _now(), placement_id),
                )
                if cursor.rowcount == 0:
                    raise PlacementNotFoundError(f"No placement with id {placement_id}.")
                row = connection.execute(
                    "SELECT * FROM placements WHERE id = ?", (placement_id,)
                ).fetchone()
        except sqlite3.IntegrityError as exc:
            raise DuplicatePlacementError(f"A placement named '{name}' already exists.") from exc
        return self._to_placement(row)

    def delete(self, placement_id: int) -> None:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM placements WHERE id = ?", (placement_id,))
            if cursor.rowcount == 0:
                raise PlacementNotFoundError(f"No placement with id {placement_id}.")

    @staticmethod
    def bounds_mismatch(placement: Placement, artwork_bounds: list[float]) -> str | None:
        """Warn when a saved placement is applied to a differently sized artboard."""
        saved_w = placement.artwork_bounds[2] - placement.artwork_bounds[0]
        saved_h = placement.artwork_bounds[3] - placement.artwork_bounds[1]
        new_w = artwork_bounds[2] - artwork_bounds[0]
        new_h = artwork_bounds[3] - artwork_bounds[1]
        if saved_w <= 0 or saved_h <= 0:
            return None
        if (
            abs(new_w - saved_w) / saved_w <= _BOUNDS_TOLERANCE
            and abs(new_h - saved_h) / saved_h <= _BOUNDS_TOLERANCE
        ):
            return None
        return (
            f"This drawing's artboard is {new_w:.0f}x{new_h:.0f} pt but the saved placement "
            f"was made against {saved_w:.0f}x{saved_h:.0f} pt. Check the alignment."
        )
