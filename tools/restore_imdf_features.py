"""Undo destructive IMDF auto-fixes by grafting from a reference archive.

Two auto-fix actions remove data the session keeps no copy of, so re-exporting
cannot bring it back:

``remove_interior_rings``
    Rebuilt every holed polygon from its exterior ring alone, filling in
    courtyards, atria and building cut-outs, and growing the affected units over
    their neighbours.

``delete_feature``
    Dropped one side of each duplicate-geometry pair and every unit flagged as a
    sliver.

This restores both from an archive that still has them -- normally the pre-edit
export or the original producer's output.

    python tools/restore_imdf_features.py DAMAGED.zip --reference ORIGINAL.zip
    python tools/restore_imdf_features.py DAMAGED.zip --reference ORIGINAL.zip --deleted

Matching is by feature id within the same ``<type>.geojson`` layer, so features
added or edited after the damage are left untouched. Deleted-feature restoration
is opt-in because an archive cannot distinguish an auto-fix deletion from one the
user meant; the report lists exactly what came back.
"""

from __future__ import annotations

import argparse
import json
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union


# A ring is accepted onto the damaged shell only if it essentially lies inside
# it. This is what actually has to hold for the graft to be meaningful, and it
# stays true across the sub-cm renoding differences between two exports, which
# a strict area-equality test does not.
RING_ESCAPE_TOLERANCE = 1e-3

# Properties that carry a reference to another feature's id. Used to report
# whether anything restored points at a feature that is no longer present.
ID_REFERENCE_KEYS = (
    "address_id",
    "anchor_id",
    "building_ids",
    "feature_ids",
    "level_id",
    "level_ids",
    "unit_id",
    "unit_ids",
)


@dataclass
class Report:
    repaired: list[tuple[str, str, int]] = field(default_factory=list)
    restored: list[tuple[str, str]] = field(default_factory=list)
    skipped_shell_changed: list[tuple[str, str]] = field(default_factory=list)
    dangling: list[tuple[str, str, str, str]] = field(default_factory=list)
    already_intact: int = 0

    @property
    def rings_restored(self) -> int:
        return sum(rings for _, _, rings in self.repaired)


def _interiors(geom: Any) -> list[Polygon]:
    """Every interior ring of a (Multi)Polygon, as filled polygons."""
    if isinstance(geom, Polygon):
        return [Polygon(ring) for ring in geom.interiors]
    if isinstance(geom, MultiPolygon):
        return [Polygon(ring) for part in geom.geoms for ring in part.interiors]
    return []


def _shell(geom: Any) -> Any:
    if isinstance(geom, Polygon):
        return Polygon(geom.exterior)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([Polygon(part.exterior) for part in geom.geoms])
    return geom


def _rings_fit(shell: Any, rings: list[Polygon]) -> bool:
    """Whether every reference ring still sits inside the damaged shell.

    A shell that was genuinely re-drawn after the damage pushes rings outside
    it; a shell that merely picked up extra vertices does not.
    """
    for ring in rings:
        if ring.difference(shell).area > RING_ESCAPE_TOLERANCE * ring.area:
            return False
    return True


def _graft(damaged: Any, reference: Any) -> Any | None:
    """Put ``reference``'s interior rings back into ``damaged``.

    Prefers rebuilding on the damaged shell so its coordinates survive verbatim;
    falls back to subtracting the rings, which tolerates a shell that was renoded
    or re-rounded between the two exports.
    """
    rings = _interiors(reference)
    if not rings or not _rings_fit(_shell(damaged), rings):
        return None

    if isinstance(damaged, Polygon):
        rebuilt = Polygon(damaged.exterior, [ring.exterior for ring in rings])
        if rebuilt.is_valid:
            return rebuilt

    carved = damaged.difference(unary_union(rings))
    if carved.is_empty or not carved.is_valid:
        return None
    return carved


def _index(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    features: dict[tuple[str, str], dict[str, Any]] = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            base = name.rsplit("/", 1)[-1]
            if not base.endswith(".geojson"):
                continue
            for feature in json.loads(archive.read(name)).get("features") or []:
                feature_id = feature.get("id")
                if isinstance(feature_id, str):
                    features[(base, feature_id)] = feature
    return features


def _referenced_ids(feature: dict[str, Any]) -> list[tuple[str, str]]:
    referenced: list[tuple[str, str]] = []
    properties = feature.get("properties")
    if not isinstance(properties, dict):
        return referenced
    for key in ID_REFERENCE_KEYS:
        value = properties.get(key)
        if isinstance(value, str) and value:
            referenced.append((key, value))
        elif isinstance(value, list):
            referenced.extend((key, item) for item in value if isinstance(item, str) and item)
    return referenced


def restore(
    damaged_path: Path,
    reference_path: Path,
    output_path: Path,
    restore_deleted: bool = False,
) -> Report:
    reference = _index(reference_path)
    damaged = _index(damaged_path)
    report = Report()

    missing_by_layer: dict[str, list[dict[str, Any]]] = {}
    if restore_deleted:
        for (layer, feature_id), feature in reference.items():
            if (layer, feature_id) not in damaged:
                missing_by_layer.setdefault(layer, []).append(feature)

    with zipfile.ZipFile(damaged_path) as source:
        members = source.infolist()
        payloads: dict[str, bytes] = {}

        for info in members:
            base = info.filename.rsplit("/", 1)[-1]
            raw = source.read(info.filename)
            if not base.endswith(".geojson"):
                payloads[info.filename] = raw
                continue

            collection = json.loads(raw)
            touched = False
            for feature in collection.get("features") or []:
                feature_id = feature.get("id")
                geometry = feature.get("geometry")
                if not isinstance(feature_id, str) or not isinstance(geometry, dict):
                    continue

                damaged_geom = shape(geometry)
                if _interiors(damaged_geom):
                    report.already_intact += 1
                    continue

                original = reference.get((base, feature_id))
                if original is None or not isinstance(original.get("geometry"), dict):
                    continue
                reference_geom = shape(original["geometry"])
                rings = _interiors(reference_geom)
                if not rings:
                    continue

                grafted = _graft(damaged_geom, reference_geom)
                if grafted is None:
                    report.skipped_shell_changed.append((base, feature_id))
                    continue

                feature["geometry"] = mapping(grafted)
                report.repaired.append((base, feature_id, len(rings)))
                touched = True

            for feature in missing_by_layer.pop(base, []):
                collection.setdefault("features", []).append(feature)
                report.restored.append((base, str(feature.get("id"))))
                touched = True

            payloads[info.filename] = (
                json.dumps(collection, ensure_ascii=False).encode("utf-8") if touched else raw
            )

        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as target:
            for info in members:
                target.writestr(info.filename, payloads[info.filename])

    present = {feature_id for _, feature_id in _index(output_path)}
    for layer, feature_id in report.restored:
        for key, target_id in _referenced_ids(reference[(layer, feature_id)]):
            if target_id not in present:
                report.dangling.append((layer, feature_id, key, target_id))

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("damaged", type=Path, help="IMDF archive that lost data to auto-fix")
    parser.add_argument("--reference", type=Path, required=True, help="archive that still has it")
    parser.add_argument("--output", type=Path, help="defaults to <damaged stem> restored.zip beside the input")
    parser.add_argument(
        "--deleted",
        action="store_true",
        help="also re-insert features present in the reference but missing here",
    )
    args = parser.parse_args()

    output = args.output or args.damaged.with_name(f"{args.damaged.stem} restored.zip")
    report = restore(args.damaged, args.reference, output, restore_deleted=args.deleted)

    def _tally(pairs: list[Any]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for entry in pairs:
            counts[entry[0]] = counts.get(entry[0], 0) + 1
        return counts

    print(f"wrote {output}")
    print(f"  rings regrafted   : {len(report.repaired)} features ({report.rings_restored} rings)")
    for layer, count in sorted(_tally(report.repaired).items()):
        print(f"    {layer}: {count}")
    if args.deleted:
        print(f"  features restored : {len(report.restored)}")
        for layer, count in sorted(_tally(report.restored).items()):
            print(f"    {layer}: {count}")
    if report.already_intact:
        print(f"  already had holes : {report.already_intact}")
    if report.skipped_shell_changed:
        print(f"  SKIPPED, shell no longer matches the reference: {len(report.skipped_shell_changed)}")
        for layer, feature_id in report.skipped_shell_changed:
            print(f"    {layer} {feature_id}")
    if report.dangling:
        print(f"  DANGLING references in restored features: {len(report.dangling)}")
        for layer, feature_id, key, target_id in report.dangling:
            print(f"    {layer} {feature_id[:8]} {key} -> {target_id[:8]} (absent)")


if __name__ == "__main__":
    main()
