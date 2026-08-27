"""Convert Adobe Illustrator (.ai) artwork into a GeoPackage.

Modern ``.ai`` files are PDF-1.x containers. Their content streams draw every
shape inside an Optional Content Group (``/OC /MCx BDC ... EMC``) that maps, via
the page ``/Properties`` resource, to a named layer (e.g. ``線路`` / tracks,
``駅舎外建物`` / buildings outside the station).

This module walks those content streams, keeps track of which layer is active,
and turns each **filled** path into a polygon and each **stroked** path into a
line, preserving the original color (converted to ``#RRGGBB``). The result is a
GeoPackage with **one layer per Illustrator layer** (split by geometry type,
since GeoPackage stores a single geometry type per table).

Coordinates are the artwork's own PDF points (bottom-left origin, so already
"north up" for GIS viewers); the output is intentionally **not** georeferenced.
"""

from __future__ import annotations

import logging
import math
import tempfile
import warnings
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any

import geopandas as gpd
from pdfminer.pdfdevice import PDFDevice
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfparser import PDFParser
from pdfminer.pdftypes import dict_value, list_value, resolve1
from pdfminer.psparser import PSLiteral, literal_name
from pdfminer.utils import apply_matrix_pt
from shapely import make_valid
from shapely.affinity import affine_transform
from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.ops import unary_union

from backend.src.illustrator_qgis import QgisLayerSpec, build_qgs_project

log = logging.getLogger(__name__)

NO_LAYER = "(no layer)"
_LINE_SUFFIX = "__lines"
# Curves (`c`/`v`/`y`) are flattened into this many straight segments.
_BEZIER_STEPS = 16
_MIN_RING_POINTS = 3
# Pages are normalized to their own MediaBox origin, so copied floor geometry
# can start at a different translation, rotation, or scale on each sheet.
_ALIGN_CANDIDATES = 40
_ALIGN_SAMPLES = 48
_ALIGN_MIN_AREA_FRACTION = 0.002
_ALIGN_AREA_RATIO = 2.5
_ALIGN_COMPACTNESS_DELTA = 0.12
_ALIGN_ELONGATION_DELTA = 0.18
_ALIGN_MATCH_MIN_IOU = 0.85
_ALIGN_MATCH_MAX_NORMALIZED_RMSE = 0.05
_ALIGN_MIN_SCALE = 0.9
_ALIGN_MAX_SCALE = 1.1
_ALIGN_MAX_ABS_ROTATION_DEG = 15.0
_ALIGN_MIN_SUPPORT = 3
_ALIGN_RUNNER_SUPPORT_RATIO = 0.8
_ALIGN_SUPPORT_DIAGONAL_FRACTION = 0.2
_ALIGN_ROTATION_TOLERANCE_DEG = 0.25
_ALIGN_SCALE_TOLERANCE = 0.005
# An outline whose bounding box spans this much of the sheet in both axes is a
# border or clipping rectangle. Repeated frames must not count as floor evidence.
_FRAME_COVERAGE = 0.85


class IllustratorConversionError(RuntimeError):
    """Raised when an .ai/PDF file cannot be parsed or converted."""


@dataclass(slots=True)
class ConversionReport:
    """Summary of a conversion, suitable for JSON serialization."""

    source_name: str
    page_count: int = 0
    # One entry per page: {"index": 1-based, "width_pt": ..., "height_pt": ...}.
    # Sizes are the visual extent, so a /Rotate 90 page reports them swapped.
    pages: list[dict[str, float]] = field(default_factory=list)
    layers: dict[str, dict[str, int]] = field(default_factory=dict)
    total_features: int = 0
    warnings: list[str] = field(default_factory=list)
    layer_order: list[str] = field(default_factory=list)
    # One entry per non-anchor page: the applied similarity and independent
    # support count, or identity plus a rejection reason. Empty for one page.
    page_alignment: list[dict[str, Any]] = field(default_factory=list)

    def record(self, layer: str, role: str) -> None:
        counts = self.layers.setdefault(layer, {"polygon": 0, "line": 0})
        counts[role] += 1
        self.total_features += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_name": self.source_name,
            "page_count": self.page_count,
            "pages": self.pages,
            "total_features": self.total_features,
            "layers": self.layers,
            "layer_order": self.layer_order,
            "warnings": self.warnings,
            "page_alignment": self.page_alignment,
        }


@dataclass(slots=True)
class _PathRecord:
    """A single painted path, resolved to its page, layer, role and color."""

    page: int  # 1-based PDF page the path was painted on
    layer: str
    role: str  # "polygon" or "line"
    subpaths: list[list[tuple[float, float]]]
    fill_color: str | None
    stroke_color: str | None
    line_width: float
    dashed: bool


# --------------------------------------------------------------------------- #
# Color helpers
# --------------------------------------------------------------------------- #

def _clamp01(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def _color_to_hex(color: Any) -> str | None:
    """Convert a pdfminer graphics-state color to ``#RRGGBB``.

    pdfminer stores gray as a float, RGB/CMYK as tuples (components 0..1), and
    patterns as strings/tuples we cannot represent as a flat color.
    """
    if isinstance(color, bool):  # guard: bool is an int subclass
        return None
    if isinstance(color, (int, float)):
        v = round(_clamp01(float(color)) * 255)
        return f"#{v:02X}{v:02X}{v:02X}"
    if isinstance(color, (tuple, list)):
        if len(color) == 3 and all(isinstance(c, (int, float)) for c in color):
            r, g, b = (_clamp01(float(c)) for c in color)
        elif len(color) == 4 and all(isinstance(c, (int, float)) for c in color):
            c, m, y, k = (_clamp01(float(x)) for x in color)
            r, g, b = (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
        else:
            return None  # pattern / unsupported component count
        return f"#{round(r * 255):02X}{round(g * 255):02X}{round(b * 255):02X}"
    return None


def _is_dashed(dash: Any) -> bool:
    if not dash:
        return False
    pattern = dash[0] if isinstance(dash, (tuple, list)) else dash
    return bool(pattern) if isinstance(pattern, (tuple, list)) else False


def _decode_pdf_text(value: Any) -> str | None:
    """Decode a PDF text string (UTF-16BE with BOM, else PDFDoc/latin-1)."""
    if isinstance(value, PSLiteral):
        return literal_name(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        if raw.startswith(b"\xfe\xff"):
            return raw[2:].decode("utf-16-be", "replace")
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("latin-1", "replace")
    return None


# --------------------------------------------------------------------------- #
# Path geometry helpers
# --------------------------------------------------------------------------- #

def _flatten_bezier(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
) -> list[tuple[float, float]]:
    pts = []
    for i in range(1, _BEZIER_STEPS + 1):
        t = i / _BEZIER_STEPS
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def _transform_path(path: list[tuple], ctm: tuple) -> list[list[tuple[float, float]]]:
    """Apply the CTM and flatten curves into a list of subpaths (point lists)."""
    subpaths: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    last = (0.0, 0.0)

    def tp(x: float, y: float) -> tuple[float, float]:
        return apply_matrix_pt(ctm, (x, y))

    for seg in path:
        op = seg[0]
        if op == "m":
            if len(current) >= 2:
                subpaths.append(current)
            last = tp(seg[1], seg[2])
            current = [last]
        elif op == "l":
            last = tp(seg[1], seg[2])
            current.append(last)
        elif op == "c":
            p1, p2, p3 = tp(seg[1], seg[2]), tp(seg[3], seg[4]), tp(seg[5], seg[6])
            current.extend(_flatten_bezier(last, p1, p2, p3))
            last = p3
        elif op == "v":  # first control point == current point
            p2, p3 = tp(seg[1], seg[2]), tp(seg[3], seg[4])
            current.extend(_flatten_bezier(last, last, p2, p3))
            last = p3
        elif op == "y":  # last control point == end point
            p1, p3 = tp(seg[1], seg[2]), tp(seg[3], seg[4])
            current.extend(_flatten_bezier(last, p1, p3, p3))
            last = p3
        elif op == "h":
            if current and current[0] != current[-1]:
                current.append(current[0])
    if len(current) >= 2:
        subpaths.append(current)
    return subpaths


def _dedupe(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in points:
        if not out or out[-1] != p:
            out.append(p)
    return out


def _build_polygon(subpaths: list[list[tuple[float, float]]]) -> Any:
    """Assemble closed subpaths into a (Multi)Polygon, nesting holes by parity."""
    rings: list[Polygon] = []
    for pts in subpaths:
        ring = _dedupe(pts)
        if ring and ring[0] != ring[-1]:
            ring = ring + [ring[0]]  # fills implicitly close
        if len(ring) < _MIN_RING_POINTS + 1:
            continue
        poly = Polygon(ring)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty and poly.area > 0:
            rings.append(poly)
    if not rings:
        return None

    # A ring nested inside an odd number of other rings is a hole; assign each
    # hole to the tightest ring that encloses it.
    #
    # Nesting is tested with whole geometry (`covers`), never a sampled point: a
    # concentric ring encloses the outer ring's representative point too, so
    # point sampling reads both rings as holes, leaves no outer, and silently
    # drops the whole path.
    rings.sort(key=lambda p: p.area, reverse=True)
    depth = [
        sum(1 for j, other in enumerate(rings) if j != i and other.covers(ring))
        for i, ring in enumerate(rings)
    ]
    outers = [rings[i] for i in range(len(rings)) if depth[i] % 2 == 0]
    hole_owner: dict[int, Polygon] = {}
    for i, ring in enumerate(rings):
        if depth[i] % 2 == 0:
            continue
        enclosing = [outer for outer in outers if outer.covers(ring)]
        if enclosing:
            hole_owner[i] = min(enclosing, key=lambda o: o.area)
    # Subtract each hole rather than building Polygon(shell, holes): a hole flush
    # with its shell's edge makes that construction invalid, and repairing it
    # fills the hole straight back in. Difference also splits the shell correctly
    # when a hole spans it end to end.
    polygons = []
    for outer in outers:
        area = outer
        for i, owner in hole_owner.items():
            if owner is outer:
                area = area.difference(rings[i])
        if not area.is_empty and area.area > 0:
            polygons.append(area)
    if not polygons:
        return None
    # Overlapping subpaths are legal inside one filled path — nonzero winding
    # fills their union. A MultiPolygon of overlapping members is invalid, and
    # repairing that yields a GeometryCollection, so union them instead.
    return _polygonal_only(make_valid(unary_union(polygons)))


def _polygonal_only(geom: Any) -> Any:
    """Reduce ``geom`` to its polygonal area, or ``None`` if it has none.

    Callers must never receive a GeometryCollection: it carries no
    ``coordinates``, so the GeoJSON preview painter renders nothing and the
    placement transform raises. ``make_valid`` can still emit stray lines or
    points beside the polygons for degenerate input such as zero-width slivers
    or rings that only touch, so those parts are dropped here.
    """
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom if geom.area > 0 else None
    parts = [p for p in getattr(geom, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
    if not parts:
        return None
    merged = unary_union(parts)
    return merged if not merged.is_empty and merged.area > 0 else None


def _build_line(subpaths: list[list[tuple[float, float]]]) -> Any:
    lines = []
    for pts in subpaths:
        ring = _dedupe(pts)
        if len(ring) >= 2:
            lines.append(LineString(ring))
    if not lines:
        return None
    return lines[0] if len(lines) == 1 else MultiLineString(lines)


# --------------------------------------------------------------------------- #
# pdfminer device + interpreter
# --------------------------------------------------------------------------- #

class _RecorderDevice(PDFDevice):
    """Records painted paths, tagging each with the active Optional-Content layer and its 1-based PDF page."""

    def __init__(self, rsrcmgr: PDFResourceManager) -> None:
        super().__init__(rsrcmgr)
        self.records: list[_PathRecord] = []
        self.ctm: tuple = (1, 0, 0, 1, 0, 0)
        self.page_no = 0
        self._mc_stack: list[str | None] = []

    def begin_page(self, page: Any, ctm: tuple) -> None:
        # pdfminer calls this once per page, in order, before that page's
        # content stream — so a simple counter is the page number. Reset the
        # marked-content stack too: a page with unbalanced BDC/EMC must not
        # leak its active layer into the next page.
        super().begin_page(page, ctm)
        self.page_no += 1
        self._mc_stack.clear()

    def set_ctm(self, ctm: tuple) -> None:
        self.ctm = ctm

    # The interpreter subclass passes an already-resolved layer name (or None).
    def begin_tag(self, tag: Any, props: Any = None) -> None:
        self._mc_stack.append(props if isinstance(props, str) else None)

    def end_tag(self) -> None:
        if self._mc_stack:
            self._mc_stack.pop()

    def _current_layer(self) -> str:
        for layer in reversed(self._mc_stack):
            if layer:
                return layer
        return NO_LAYER

    def paint_path(self, gs: Any, stroke: bool, fill: bool, evenodd: bool, path: list) -> None:
        subpaths = _transform_path(path, self.ctm)
        if not subpaths:
            return
        layer = self._current_layer()
        if fill:
            self.records.append(
                _PathRecord(
                    page=self.page_no,
                    layer=layer,
                    role="polygon",
                    subpaths=subpaths,
                    fill_color=_color_to_hex(gs.ncolor),
                    stroke_color=_color_to_hex(gs.scolor) if stroke else None,
                    line_width=float(gs.linewidth or 0.0),
                    dashed=_is_dashed(gs.dash),
                )
            )
        elif stroke:
            self.records.append(
                _PathRecord(
                    page=self.page_no,
                    layer=layer,
                    role="line",
                    subpaths=subpaths,
                    fill_color=None,
                    stroke_color=_color_to_hex(gs.scolor),
                    line_width=float(gs.linewidth or 0.0),
                    dashed=_is_dashed(gs.dash),
                )
            )


class _LayerInterpreter(PDFPageInterpreter):
    """Resolves ``/OC`` marked content to the referenced OCG layer name."""

    def do_BDC(self, tag: Any, props: Any) -> None:
        self.device.begin_tag(tag, self._resolve_oc_layer(tag, props))

    def _resolve_oc_layer(self, tag: Any, props: Any) -> str | None:
        if not (isinstance(tag, PSLiteral) and literal_name(tag) == "OC"):
            return None
        ocg: Any = None
        if isinstance(props, PSLiteral):
            try:
                properties = dict_value(getattr(self, "resources", None) or {}).get("Properties")
                properties = dict_value(properties) if properties is not None else {}
            except Exception:
                properties = {}
            ref = properties.get(literal_name(props))
            ocg = resolve1(ref) if ref is not None else None
        elif isinstance(props, dict):
            ocg = props
        return self._ocg_name(ocg)

    @staticmethod
    def _ocg_name(ocg: Any) -> str | None:
        ocg = resolve1(ocg)
        if not isinstance(ocg, dict):
            return None
        if "Name" in ocg:
            return _decode_pdf_text(resolve1(ocg["Name"]))
        if "OCGs" in ocg:  # OCMD referencing one or more OCGs
            ocgs = resolve1(ocg["OCGs"])
            if isinstance(ocgs, list) and ocgs:
                ocgs = resolve1(ocgs[0])
            if isinstance(ocgs, dict) and "Name" in ocgs:
                return _decode_pdf_text(resolve1(ocgs["Name"]))
        return None


# --------------------------------------------------------------------------- #
# GeoPackage writing
# --------------------------------------------------------------------------- #

def _sanitize_layer_name(name: str, taken: set[str]) -> str:
    cleaned = "".join(c if c.isalnum() or c in " _-()、。・" else "_" for c in name).strip()
    cleaned = cleaned or "layer"
    candidate, n = cleaned, 1
    while candidate in taken:
        n += 1
        candidate = f"{cleaned}_{n}"
    taken.add(candidate)
    return candidate


@dataclass(slots=True, frozen=True)
class _AlignCandidate:
    """One closed, non-frame outline considered for page registration."""

    index: int
    geom: Any
    area: float
    compactness: float
    elongation: float
    samples: tuple[tuple[float, float], ...]


@dataclass(slots=True, frozen=True)
class _AlignMatch:
    """One independently fitted source/anchor outline pair."""

    source_index: int
    target_index: int
    matrix: tuple[float, float, float, float, float, float]
    scale: float
    rotation_deg: float
    center_shift: tuple[float, float]
    overlap_iou: float
    normalized_rmse: float
    weight: float


def _ring_area(ring: list[tuple[float, float]]) -> float:
    total = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def _candidate_polygon(record: _PathRecord) -> Any:
    """The path's largest genuinely closed subpath, or ``None``.

    Filled paths are closed by the PDF paint operator even without an explicit
    ``h`` segment. A stroke is only an outline when Illustrator actually closed
    it; force-closing arbitrary open linework creates large artificial polygons
    whose area and centroid have no spatial meaning.
    """
    best_ring: list[tuple[float, float]] | None = None
    best_area = 0.0
    for points in record.subpaths:
        ring = _dedupe(points)
        explicitly_closed = len(ring) > 1 and ring[0] == ring[-1]
        if record.role != "polygon" and not explicitly_closed:
            continue
        if explicitly_closed:
            ring = ring[:-1]
        if len(ring) < _MIN_RING_POINTS:
            continue
        area = _ring_area(ring)
        if area > best_area:
            best_ring, best_area = ring, area
    if best_ring is None or best_area <= 0:
        return None
    polygon = make_valid(Polygon(best_ring))
    if polygon.geom_type == "MultiPolygon":
        polygon = max(polygon.geoms, key=lambda part: part.area)
    if polygon.geom_type != "Polygon" or polygon.area <= 0:
        return None
    return polygon


def _covers_sheet(polygon: Any, sheet: tuple[float, float]) -> bool:
    width, height = sheet
    if width <= 0 or height <= 0:
        return False
    minx, miny, maxx, maxy = polygon.bounds
    return (maxx - minx) >= _FRAME_COVERAGE * width and (maxy - miny) >= _FRAME_COVERAGE * height


def _outline_descriptor(polygon: Any) -> tuple[float, float]:
    area = float(polygon.area)
    perimeter = float(polygon.length)
    compactness = 4.0 * math.pi * area / (perimeter * perimeter) if perimeter > 0 else 0.0
    rectangle = polygon.minimum_rotated_rectangle
    coords = list(rectangle.exterior.coords)
    sides = [math.dist(coords[index], coords[index + 1]) for index in range(4)]
    short, long = min(sides), max(sides)
    return compactness, short / long if long > 0 else 1.0


def _sample_outline(polygon: Any) -> tuple[tuple[float, float], ...]:
    ring = LineString(polygon.exterior.coords)
    length = float(ring.length)
    if length <= 0:
        return ()
    return tuple(
        (float(point.x), float(point.y))
        for point in (
            ring.interpolate(index * length / _ALIGN_SAMPLES)
            for index in range(_ALIGN_SAMPLES)
        )
    )


def _page_candidates(
    records: list[_PathRecord], sheet: tuple[float, float] | None
) -> list[_AlignCandidate]:
    """Large, unique, closed outlines; decorative details never become votes."""
    minimum_area = (
        sheet[0] * sheet[1] * _ALIGN_MIN_AREA_FRACTION
        if sheet is not None
        else 0.0
    )
    found: list[_AlignCandidate] = []
    seen: set[bytes] = set()
    for record in records:
        polygon = _candidate_polygon(record)
        if polygon is None or polygon.area < minimum_area:
            continue
        if sheet is not None and _covers_sheet(polygon, sheet):
            continue
        signature = polygon.normalize().wkb
        if signature in seen:
            continue
        seen.add(signature)
        compactness, elongation = _outline_descriptor(polygon)
        samples = _sample_outline(polygon)
        if not samples:
            continue
        found.append(
            _AlignCandidate(
                index=len(found),
                geom=polygon,
                area=float(polygon.area),
                compactness=compactness,
                elongation=elongation,
                samples=samples,
            )
        )
    found.sort(key=lambda item: -item.area)
    return [
        _AlignCandidate(
            index=index,
            geom=item.geom,
            area=item.area,
            compactness=item.compactness,
            elongation=item.elongation,
            samples=item.samples,
        )
        for index, item in enumerate(found[:_ALIGN_CANDIDATES])
    ]


def _fit_point_pairs(
    source: tuple[tuple[float, float], ...],
    target: tuple[tuple[float, float], ...],
) -> tuple[tuple[float, float, float, float, float, float], float] | None:
    count = len(source)
    if count < 2 or len(target) != count:
        return None
    source_x = sum(point[0] for point in source) / count
    source_y = sum(point[1] for point in source) / count
    target_x = sum(point[0] for point in target) / count
    target_y = sum(point[1] for point in target) / count
    denominator = 0.0
    real = 0.0
    imaginary = 0.0
    for (sx, sy), (tx, ty) in zip(source, target):
        x = sx - source_x
        y = sy - source_y
        east = tx - target_x
        north = ty - target_y
        denominator += x * x + y * y
        real += x * east + y * north
        imaginary += x * north - y * east
    if denominator <= 1e-12:
        return None
    a = real / denominator
    d = imaginary / denominator
    b = -d
    e = a
    xoff = target_x - (a * source_x + b * source_y)
    yoff = target_y - (d * source_x + e * source_y)
    squared = 0.0
    for (sx, sy), (tx, ty) in zip(source, target):
        dx = a * sx + b * sy + xoff - tx
        dy = d * sx + e * sy + yoff - ty
        squared += dx * dx + dy * dy
    return (a, b, d, e, xoff, yoff), math.sqrt(squared / count)


def _fit_outlines(
    source: _AlignCandidate, target: _AlignCandidate
) -> tuple[tuple[float, float, float, float, float, float], float] | None:
    best: tuple[tuple[float, float, float, float, float, float], float] | None = None
    count = len(source.samples)
    for reverse in (False, True):
        sequence = tuple(reversed(target.samples)) if reverse else target.samples
        for start in range(count):
            paired = sequence[start:] + sequence[:start]
            fitted = _fit_point_pairs(source.samples, paired)
            if fitted is not None and (best is None or fitted[1] < best[1]):
                best = fitted
    return best


def _overlap(left: Any, right: Any) -> float:
    try:
        union_area = float(left.union(right).area)
        if union_area <= 0:
            return 0.0
        return float(left.intersection(right).area) / union_area
    except (TypeError, ValueError):
        return 0.0


def _outline_match(
    source: _AlignCandidate,
    target: _AlignCandidate,
    sheet: tuple[float, float],
) -> _AlignMatch | None:
    ratio = source.area / target.area
    if not 1.0 / _ALIGN_AREA_RATIO <= ratio <= _ALIGN_AREA_RATIO:
        return None
    if abs(source.compactness - target.compactness) > _ALIGN_COMPACTNESS_DELTA:
        return None
    if abs(source.elongation - target.elongation) > _ALIGN_ELONGATION_DELTA:
        return None
    fitted = _fit_outlines(source, target)
    if fitted is None:
        return None
    matrix, rmse = fitted
    a, b, d, e, xoff, yoff = matrix
    scale = math.hypot(a, d)
    rotation_deg = math.degrees(math.atan2(d, a))
    if (
        not _ALIGN_MIN_SCALE <= scale <= _ALIGN_MAX_SCALE
        or abs(rotation_deg) > _ALIGN_MAX_ABS_ROTATION_DEG
    ):
        return None
    moved = make_valid(affine_transform(source.geom, matrix))
    if moved.geom_type == "MultiPolygon":
        moved = max(moved.geoms, key=lambda part: part.area)
    if moved.geom_type != "Polygon":
        return None
    overlap = _overlap(moved, target.geom)
    normalized_rmse = rmse / max(math.sqrt(target.area), 1.0)
    if (
        overlap < _ALIGN_MATCH_MIN_IOU
        or normalized_rmse > _ALIGN_MATCH_MAX_NORMALIZED_RMSE
    ):
        return None
    center_x, center_y = sheet[0] / 2.0, sheet[1] / 2.0
    mapped_x = a * center_x + b * center_y + xoff
    mapped_y = d * center_x + e * center_y + yoff
    return _AlignMatch(
        source_index=source.index,
        target_index=target.index,
        matrix=matrix,
        scale=scale,
        rotation_deg=rotation_deg,
        center_shift=(mapped_x - center_x, mapped_y - center_y),
        overlap_iou=overlap,
        normalized_rmse=normalized_rmse,
        weight=math.sqrt(min(source.area, target.area)),
    )


def _rotation_difference(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def _same_transform(
    left: _AlignMatch,
    right: _AlignMatch,
    translation_tolerance: float,
) -> bool:
    return (
        math.dist(left.center_shift, right.center_shift) <= translation_tolerance
        and _rotation_difference(left.rotation_deg, right.rotation_deg)
        <= _ALIGN_ROTATION_TOLERANCE_DEG
        and abs(left.scale - right.scale) / max(left.scale, right.scale)
        <= _ALIGN_SCALE_TOLERANCE
    )


def _independent_matches(matches: list[_AlignMatch]) -> list[_AlignMatch]:
    """One vote per source and target outline; fill/stroke copies count once."""
    chosen: list[_AlignMatch] = []
    source_indexes: set[int] = set()
    target_indexes: set[int] = set()
    for match in sorted(
        matches,
        key=lambda item: (-item.overlap_iou, item.normalized_rmse, -item.weight),
    ):
        if (
            match.source_index in source_indexes
            or match.target_index in target_indexes
        ):
            continue
        chosen.append(match)
        source_indexes.add(match.source_index)
        target_indexes.add(match.target_index)
    return chosen


def _match_clusters(
    matches: list[_AlignMatch], sheet: tuple[float, float]
) -> list[list[_AlignMatch]]:
    translation_tolerance = max(1.0, math.hypot(*sheet) * 0.001)
    unique: dict[tuple[tuple[int, int], ...], list[_AlignMatch]] = {}
    for seed in matches:
        independent = _independent_matches(
            [
                match
                for match in matches
                if _same_transform(seed, match, translation_tolerance)
            ]
        )
        key = tuple(
            sorted((match.source_index, match.target_index) for match in independent)
        )
        if key:
            unique[key] = independent
    clusters = list(unique.values())
    clusters.sort(
        key=lambda cluster: (
            -len(cluster),
            -sum(match.weight for match in cluster),
            -sum(match.overlap_iou for match in cluster) / len(cluster),
        )
    )
    return clusters


def _transform_distance(
    left: _AlignMatch, right: _AlignMatch, sheet: tuple[float, float]
) -> float:
    translation_tolerance = max(1.0, math.hypot(*sheet) * 0.001)
    return (
        math.dist(left.center_shift, right.center_shift) / translation_tolerance
        + _rotation_difference(left.rotation_deg, right.rotation_deg)
        / _ALIGN_ROTATION_TOLERANCE_DEG
        + abs(left.scale - right.scale)
        / max(left.scale, right.scale)
        / _ALIGN_SCALE_TOLERANCE
    )


def _select_consensus(
    targets: list[_AlignCandidate],
    sources: list[_AlignCandidate],
    sheet: tuple[float, float],
) -> tuple[_AlignMatch, list[_AlignMatch]] | None:
    matches = [
        match
        for source in sources
        for target in targets
        if (match := _outline_match(source, target, sheet)) is not None
    ]
    clusters = _match_clusters(matches, sheet)
    if not clusters:
        return None
    best = clusters[0]
    if len(best) < _ALIGN_MIN_SUPPORT:
        return None
    if (
        len(clusters) > 1
        and len(clusters[1]) / len(best) >= _ALIGN_RUNNER_SUPPORT_RATIO
    ):
        return None
    support_bounds = [sources[match.source_index].geom.bounds for match in best]
    support_width = max(bounds[2] for bounds in support_bounds) - min(
        bounds[0] for bounds in support_bounds
    )
    support_height = max(bounds[3] for bounds in support_bounds) - min(
        bounds[1] for bounds in support_bounds
    )
    if math.hypot(support_width, support_height) < (
        math.hypot(*sheet) * _ALIGN_SUPPORT_DIAGONAL_FRACTION
    ):
        return None
    medoid = min(
        best,
        key=lambda candidate: sum(
            _transform_distance(candidate, other, sheet) for other in best
        ),
    )
    return medoid, best


def _unaligned_page(page: int, anchor: int, reason: str) -> dict[str, Any]:
    return {
        "page": page,
        "anchor_page": anchor,
        "offset": [0.0, 0.0],
        "rotation_deg": 0.0,
        "scale": 1.0,
        "overlap_iou": 0.0,
        "matched_outlines": 0,
        "aligned": False,
        "reason": reason,
    }


def _align_pages(
    records: list[_PathRecord], sheets: list[dict[str, float]]
) -> list[dict[str, Any]]:
    """Normalize each page from independent outline matches that agree.

    A single incidental path must never move a floor. Each candidate is fitted
    independently by a no-reflection similarity, then transform hypotheses are
    clustered. At least three distinct source/anchor outlines must agree;
    ambiguous or weak pages remain untouched.
    """
    by_page: dict[int, list[_PathRecord]] = {}
    for record in records:
        by_page.setdefault(record.page, []).append(record)
    if len(by_page) < 2:
        return []

    sizes = {
        int(sheet["index"]): (float(sheet["width_pt"]), float(sheet["height_pt"]))
        for sheet in sheets
    }
    candidates = {
        page: _page_candidates(page_records, sizes.get(page))
        for page, page_records in by_page.items()
    }
    ordered = sorted(by_page)
    anchor = next((page for page in ordered if candidates[page]), None)
    if anchor is None:
        return []

    alignment: list[dict[str, Any]] = []
    for page in ordered:
        if page == anchor:
            continue
        sheet = sizes.get(page)
        if sheet is None:
            alignment.append(_unaligned_page(page, anchor, "missing_sheet"))
            continue
        selected = _select_consensus(
            candidates[anchor],
            candidates[page],
            sheet,
        )
        if selected is None:
            alignment.append(_unaligned_page(page, anchor, "no_consensus"))
            continue
        match, supporting = selected
        a, b, d, e, xoff, yoff = match.matrix
        if match.matrix != (1.0, 0.0, 0.0, 1.0, 0.0, 0.0):
            for record in by_page[page]:
                record.subpaths = [
                    [
                        (
                            a * x + b * y + xoff,
                            d * x + e * y + yoff,
                        )
                        for x, y in subpath
                    ]
                    for subpath in record.subpaths
                ]
        overlaps = sorted(item.overlap_iou for item in supporting)
        median_overlap = overlaps[len(overlaps) // 2]
        alignment.append(
            {
                "page": page,
                "anchor_page": anchor,
                "offset": [round(xoff, 4), round(yoff, 4)],
                "rotation_deg": round(match.rotation_deg, 4),
                "scale": round(match.scale, 6),
                "overlap_iou": round(median_overlap, 4),
                "matched_outlines": len(supporting),
                "aligned": True,
                "reason": None,
            }
        )
    return alignment


def _records_to_rows(records: list[_PathRecord], report: ConversionReport) -> tuple[list[dict], list]:
    rows: list[dict] = []
    geoms: list = []
    for rec in records:
        geom = _build_polygon(rec.subpaths) if rec.role == "polygon" else _build_line(rec.subpaths)
        if geom is None or geom.is_empty:
            report.warnings.append(f"Dropped empty {rec.role} on layer '{rec.layer}'")
            continue
        rows.append(
            {
                "page": rec.page,
                "ai_layer": rec.layer,
                "role": rec.role,
                "fill_color": rec.fill_color,
                "stroke_color": rec.stroke_color,
                "line_width": round(rec.line_width, 4),
                "dashed": rec.dashed,
            }
        )
        geoms.append(geom)
        report.record(rec.layer, rec.role)
    return rows, geoms


def _write_geopackage(
    records: list[_PathRecord], report: ConversionReport
) -> tuple[bytes, list[dict[str, str]]]:
    """Write one GeoPackage table per (layer, geometry role).

    Returns the GeoPackage bytes and a list of ``{"table", "ai_layer", "role"}``
    descriptors for the tables actually written.
    """
    # Group by (layer, role) so each GeoPackage table holds one geometry type.
    grouped: dict[tuple[str, str], list[_PathRecord]] = {}
    for rec in records:
        grouped.setdefault((rec.layer, rec.role), []).append(rec)

    # One sanitized base name per AI layer, so a layer's polygon and line tables
    # share a base (e.g. "線路" and "線路__lines") instead of colliding.
    taken: set[str] = set()
    base_names = {layer: _sanitize_layer_name(layer, taken) for layer in sorted({k[0] for k in grouped})}

    written: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory() as tmp:
        gpkg_path = Path(tmp) / "output.gpkg"
        # Deterministic order: layer, then polygons before lines.
        for (layer, role) in sorted(grouped, key=lambda k: (k[0], k[1] != "polygon")):
            rows, geoms = _records_to_rows(grouped[(layer, role)], report)
            if not rows:
                continue
            base = base_names[layer]
            table = base if role == "polygon" else f"{base}{_LINE_SUFFIX}"
            gdf = gpd.GeoDataFrame(rows, geometry=geoms, crs=None)
            with warnings.catch_warnings():
                # The output is intentionally non-georeferenced (PDF points).
                warnings.filterwarnings("ignore", message=".*'crs' was not provided.*")
                gdf.to_file(gpkg_path, driver="GPKG", layer=table)
            written.append({"table": table, "ai_layer": layer, "role": role})
        if not written:
            raise IllustratorConversionError("No vector polygons or lines were found in the file.")
        return gpkg_path.read_bytes(), written


def _extract_layer_order(document: PDFDocument) -> list[str]:
    """Illustrator layer order (top-first) from ``/OCProperties /D /Order``."""
    order: list[str] = []
    try:
        ocp = resolve1(document.catalog.get("OCProperties"))
        d = resolve1(dict_value(ocp).get("D"))
        raw_order = resolve1(dict_value(d).get("Order"))
    except Exception:
        return order

    def walk(obj: Any) -> None:
        obj = resolve1(obj)
        if isinstance(obj, list):
            for item in obj:
                walk(item)
            return
        name = _LayerInterpreter._ocg_name(obj)
        if name and name not in order:
            order.append(name)

    walk(raw_order)
    return order


def _order_layers(written: list[dict[str, str]], layer_order: list[str]) -> list[QgisLayerSpec]:
    """Order written tables to match the Illustrator stack (top layer first)."""
    rank = {name: i for i, name in enumerate(layer_order)}
    fallback = len(rank)

    def sort_key(entry: dict[str, str]) -> tuple[int, int]:
        # Follow AI layer order; within a layer put lines above polygons.
        return (rank.get(entry["ai_layer"], fallback), 0 if entry["role"] == "line" else 1)

    return [
        QgisLayerSpec(table=e["table"], display_name=e["ai_layer"], role=e["role"])
        for e in sorted(written, key=sort_key)
    ]


@dataclass(slots=True)
class _ConversionResult:
    gpkg_bytes: bytes
    written_layers: list[dict[str, str]]
    layer_order: list[str]
    report: ConversionReport
    stem: str


def _convert(ai_bytes: bytes, source_name: str) -> _ConversionResult:
    if not ai_bytes:
        raise IllustratorConversionError("The uploaded file is empty.")
    if not ai_bytes.lstrip()[:5].startswith(b"%PDF"):
        raise IllustratorConversionError(
            "Not a PDF-based Illustrator file. Save the .ai with 'Create PDF Compatible File' enabled."
        )

    report = ConversionReport(source_name=source_name)
    rsrcmgr = PDFResourceManager()
    device = _RecorderDevice(rsrcmgr)
    interpreter = _LayerInterpreter(rsrcmgr, device)

    try:
        parser = PDFParser(BytesIO(ai_bytes))
        document = PDFDocument(parser)
        for page in PDFPage.create_pages(document):
            report.page_count += 1
            x0, y0, x1, y1 = page.mediabox
            width, height = abs(x1 - x0), abs(y1 - y0)
            if page.rotate in (90, 270):
                # pdfminer folds /Rotate into the base CTM, so the visual
                # extent is the MediaBox with its axes swapped.
                width, height = height, width
            report.pages.append(
                {
                    "index": report.page_count,
                    "width_pt": round(width, 4),
                    "height_pt": round(height, 4),
                }
            )
            interpreter.process_page(page)
        layer_order = _extract_layer_order(document)
    except IllustratorConversionError:
        raise
    except Exception as exc:  # pdfminer raises a variety of exception types
        raise IllustratorConversionError(f"Failed to parse the Illustrator file: {exc}") from exc

    report.layer_order = layer_order
    report.page_alignment = _align_pages(device.records, report.pages)
    gpkg_bytes, written = _write_geopackage(device.records, report)
    stem = Path(source_name).stem or "illustrator"
    return _ConversionResult(gpkg_bytes, written, layer_order, report, stem)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def convert_ai_to_geopackage(ai_bytes: bytes, source_name: str) -> tuple[bytes, str, ConversionReport]:
    """Convert Illustrator/PDF ``ai_bytes`` into a GeoPackage.

    Returns ``(gpkg_bytes, filename, report)``. Raises
    :class:`IllustratorConversionError` for unparseable input.
    """
    result = _convert(ai_bytes, source_name)
    return result.gpkg_bytes, f"{result.stem}.gpkg", result.report


def convert_ai_to_geopackage_bundle(ai_bytes: bytes, source_name: str) -> tuple[bytes, str, ConversionReport]:
    """Convert to a ``.zip`` bundling the GeoPackage and a styled QGIS project.

    The ``.qgs`` references the ``.gpkg`` by relative path, orders layers to match
    the Illustrator stack, and colors each layer from its ``fill_color`` /
    ``stroke_color`` attribute. Returns ``(zip_bytes, filename, report)``.
    """
    result = _convert(ai_bytes, source_name)
    gpkg_name = f"{result.stem}.gpkg"
    qgs_name = f"{result.stem}.qgs"
    ordered = _order_layers(result.written_layers, result.layer_order)
    qgs_xml = build_qgs_project(ordered, gpkg_filename=gpkg_name, project_name=result.stem)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(gpkg_name, result.gpkg_bytes)
        archive.writestr(qgs_name, qgs_xml.encode("utf-8"))
    return buffer.getvalue(), f"{result.stem}.zip", result.report


def parse_ai(ai_bytes: bytes, source_name: str) -> _ConversionResult:
    """Parse an ``.ai``/PDF into vector layers without georeferencing it.

    Exposed so :mod:`backend.src.illustrator_store` can cache the expensive
    parse and reuse it for both preview and export.
    """
    return _convert(ai_bytes, source_name)
