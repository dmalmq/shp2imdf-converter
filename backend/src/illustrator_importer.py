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
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon

from backend.src.illustrator_qgis import QgisLayerSpec, build_qgs_project

log = logging.getLogger(__name__)

NO_LAYER = "(no layer)"
_LINE_SUFFIX = "__lines"
# Curves (`c`/`v`/`y`) are flattened into this many straight segments.
_BEZIER_STEPS = 16
_MIN_RING_POINTS = 3


class IllustratorConversionError(RuntimeError):
    """Raised when an .ai/PDF file cannot be parsed or converted."""


@dataclass(slots=True)
class ConversionReport:
    """Summary of a conversion, suitable for JSON serialization."""

    source_name: str
    page_count: int = 0
    layers: dict[str, dict[str, int]] = field(default_factory=dict)
    total_features: int = 0
    warnings: list[str] = field(default_factory=list)
    layer_order: list[str] = field(default_factory=list)

    def record(self, layer: str, role: str) -> None:
        counts = self.layers.setdefault(layer, {"polygon": 0, "line": 0})
        counts[role] += 1
        self.total_features += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_name": self.source_name,
            "page_count": self.page_count,
            "total_features": self.total_features,
            "layers": self.layers,
            "layer_order": self.layer_order,
            "warnings": self.warnings,
        }


@dataclass(slots=True)
class _PathRecord:
    """A single painted path, resolved to its layer, geometry role and color."""

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
    # hole to the smallest ring that contains it.
    rings.sort(key=lambda p: p.area, reverse=True)
    depth = [sum(1 for j, o in enumerate(rings) if j != i and o.contains(p.representative_point()))
             for i, p in enumerate(rings)]
    outers = [(i, rings[i]) for i in range(len(rings)) if depth[i] % 2 == 0]
    polygons: list[Polygon] = []
    for oi, outer in outers:
        holes = []
        for i, ring in enumerate(rings):
            if depth[i] % 2 == 1 and outer.contains(ring.representative_point()):
                # tightest container among outers is this one?
                container = min(
                    (o for _, o in outers if o.contains(ring.representative_point())),
                    key=lambda o: o.area,
                    default=None,
                )
                if container is outer:
                    holes.append(list(ring.exterior.coords))
        polygons.append(Polygon(list(outer.exterior.coords), holes))
    if not polygons:
        return None
    geom = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
    geom = make_valid(geom)
    return geom if not geom.is_empty else None


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
    """Records painted paths, tagging each with the active Optional-Content layer."""

    def __init__(self, rsrcmgr: PDFResourceManager) -> None:
        super().__init__(rsrcmgr)
        self.records: list[_PathRecord] = []
        self.ctm: tuple = (1, 0, 0, 1, 0, 0)
        self._mc_stack: list[str | None] = []

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
            interpreter.process_page(page)
        layer_order = _extract_layer_order(document)
    except IllustratorConversionError:
        raise
    except Exception as exc:  # pdfminer raises a variety of exception types
        raise IllustratorConversionError(f"Failed to parse the Illustrator file: {exc}") from exc

    report.layer_order = layer_order
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
