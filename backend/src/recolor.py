"""Apply the colour theme to one uploaded station. Every file comes back; only ``color2`` changes.

The upload becomes a ``FileTree``: relative path to bytes, in upload order.
Entries under a folder named ``*.gdb`` belong to a File Geodatabase;
everything else is a shapefile's or passes through. Each ``.dbf`` that
carries the theme's field is decoded here (the one decode/encode boundary),
planned by ``color_theme.plan`` and patched by ``DbfTable.with_text``. No
shapefile geometry is opened, so PolygonZM measures, .prj text and spatial
indexes cannot drift.

A geodatabase is written to a temporary folder, read and updated in place
there through ``gdb.py``, and its entries are replaced by the files on disk.
GDAL rewrites each edited row, so for a geodatabase the guarantee is per
table: a table without edits comes back byte for byte. Stale ``*.lock``
files inside a ``.gdb`` are left out.

An ``.lyrx`` is parsed as CIM JSON and an ``.aprx`` as a zip of CIM JSON
members; ``cim_symbology`` rewrites their ``color2`` renderers. A file with
nothing to rewrite comes back byte for byte, and in a project every member
without a rewritten renderer comes back with the same name, date and bytes.

``inspect`` and ``convert`` share one private pass, so the report the
operator checks and the archive they download come from the same plan.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
from tempfile import TemporaryDirectory
import time
from typing import Any, NewType
import zipfile
import zlib

from backend.src.cim_symbology import retheme_document
from backend.src.color_theme import (
    ColorTheme,
    Encoding,
    LayerInput,
    RendererChange,
    Row,
    SkippedLayer,
    SymbologyKind,
    SymbologyLine,
    ThemePlan,
    ThemeReport,
    plan,
)
from backend.src.dbf_table import DbfField, DbfLayoutError, DbfTable, resolve_codec
from backend.src.gdb import apply_edits, read_layers
from backend.src.importer import zip_member_name

DOWNLOAD_SUFFIX = "_new-colors"
"""The archive is ``<station><suffix>.zip``."""


@dataclass(frozen=True, slots=True)
class DatasetInfo:
    name: str
    """The zip's stem; else the shared top folder; else the files' shared leading ``_`` tokens; else
    ``station``. A trailing ``.shp`` or ``.gdb`` is dropped (``JRTokyoSta_6677.shp`` gives ``JRTokyoSta_6677``)."""
    download_name: str
    files: int
    """Every file in the upload that comes back: the untouched ones included, lock files not."""
    geodatabases: int
    lock_files_dropped: int
    """Stale ``*.lock`` files inside a ``.gdb``, left out of the download."""


@dataclass(frozen=True, slots=True)
class Inspection:
    dataset: DatasetInfo
    theme: ThemeReport


@dataclass(frozen=True, slots=True)
class Archive:
    filename: str
    data: bytes


def inspect(
    theme: ColorTheme, blobs: Sequence[tuple[str, bytes]], *, max_bytes: int, gdal_python: Path | None = None
) -> Inspection:
    """What converting this upload would change. Writes nothing but a temporary copy of its geodatabases.

    ``gdal_python`` runs ``gdb_worker.py``; without one each geodatabase is ``gdb_unavailable``.
    """
    with _workspace() as workspace:
        survey = _survey(theme, blobs, max_bytes=max_bytes, gdal_python=gdal_python, workspace=Path(workspace))
    return Inspection(dataset=survey.dataset, theme=survey.plan.report)


def convert(
    theme: ColorTheme, blobs: Sequence[tuple[str, bytes]], *, max_bytes: int, gdal_python: Path | None = None
) -> Archive:
    """The upload as a zip with the theme applied: same entries, same order, same bytes but the edits.

    In a geodatabase with edits, the edited tables come back as GDAL
    rewrote them and files GDAL added follow its last entry. Converting a
    converted upload finds every value already new and returns the same
    entries with the same bytes.
    """
    with _workspace() as workspace:
        survey = _survey(theme, blobs, max_bytes=max_bytes, gdal_python=gdal_python, workspace=Path(workspace))
        tree = survey.tree
        for gdb in survey.geodatabases:
            edits = {
                layer_id.removeprefix(f"{gdb.path}/"): survey.plan.edits[layer_id]
                for layer_id in gdb.layers
                if layer_id in survey.plan.edits
            }
            if edits:
                apply_edits(gdb.directory, theme.field, edits, gdb.python)
                tree = _reloaded(tree, gdb)
    replaced = {
        path: _patch(table, survey.plan.edits[path]) for path, table in survey.tables.items() if path in survey.plan.edits
    }
    replaced.update(survey.symbology)
    return Archive(filename=survey.dataset.download_name, data=_write_zip(tree, replaced))


def _workspace() -> TemporaryDirectory[str]:
    # A virus scanner can still hold a file GDAL just wrote; a leftover folder must not fail a finished conversion.
    return TemporaryDirectory(prefix="color-theme-", ignore_cleanup_errors=True)


TreePath = NewType("TreePath", str)
"""Relative POSIX path: no drive, no leading slash, no ``.`` or ``..`` segments. Directories end in ``/``."""


@dataclass(frozen=True, slots=True)
class TreeEntry:
    path: TreePath
    data: bytes | None
    """None for a directory entry."""
    source: zipfile.ZipInfo | None
    """The member this came from when the upload was a zip; its date and attributes are reused."""


@dataclass(frozen=True, slots=True)
class FileTree:
    name: str
    entries: tuple[TreeEntry, ...]


_DRIVE = re.compile(r"^[A-Za-z]:")
_CONTAINER_SUFFIX = re.compile(r"\.(shp|gdb)$", re.IGNORECASE)
EXPANDED_LIMIT_MESSAGE = "Expanded upload exceeds configured limit (MAX_UPLOAD_MB)."


def _tree_path(raw: str) -> TreePath:
    """Normalise the forms browsers report (``/Folder/a.dbf``, ``./a.dbf``); refuse anything that could escape."""
    path = raw.replace("\\", "/")
    if path.startswith("//") or _DRIVE.match(path) or any(ord(ch) < 0x20 for ch in path):
        raise ValueError(f"Unsafe path in upload: {raw!r}")
    segments = [segment for segment in path.split("/") if segment not in ("", ".")]
    if not segments or ".." in segments:
        raise ValueError(f"Unsafe path in upload: {raw!r}")
    return TreePath("/".join(segments) + ("/" if path.endswith("/") else ""))


def _container_name(name: str) -> str:
    """``JRTokyoSta_6677.shp`` and this tool's own ``JRTokyoSta_6677_new-colors`` both name ``JRTokyoSta_6677``."""
    return _CONTAINER_SUFFIX.sub("", name.removesuffix(DOWNLOAD_SUFFIX)) or name


def _tree_from_upload(blobs: Sequence[tuple[str, bytes]], *, max_bytes: int) -> FileTree:
    """Parse the upload at the boundary.

    One blob that is a ``.zip`` with no folder in its path is a zipped station:
    its members are the tree, and their declared sizes are checked against the
    limit before anything inflates. Anything else is a folder upload, and a
    zip inside it is just a file that comes back untouched.
    """
    if not blobs:
        raise ValueError("No files were uploaded.")
    paths = [_tree_path(name) for name, _ in blobs]
    if len(blobs) == 1 and "/" not in paths[0] and paths[0].lower().endswith(".zip"):
        return _tree_from_zip(PurePosixPath(paths[0]).stem, blobs[0][1], max_bytes=max_bytes)
    entries = tuple(TreeEntry(path=path, data=data, source=None) for path, (_, data) in zip(paths, blobs))
    return FileTree(name=_folder_name(paths), entries=_unique(entries))


def _tree_from_zip(stem: str, payload: bytes, *, max_bytes: int) -> FileTree:
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        members = archive.infolist()
        if sum(info.file_size for info in members) > max_bytes:
            raise ValueError(EXPANDED_LIMIT_MESSAGE)
        entries: list[TreeEntry] = []
        for info in members:
            path = _tree_path(zip_member_name(info))
            try:
                data = None if info.is_dir() else archive.read(info)
            except (RuntimeError, NotImplementedError, zipfile.BadZipFile) as exc:
                raise ValueError(f"Could not read {path} from the zip: {exc}") from exc
            entries.append(TreeEntry(path=path, data=data, source=info))
    return FileTree(name=_container_name(stem), entries=_unique(tuple(entries)))


def _unique(entries: tuple[TreeEntry, ...]) -> tuple[TreeEntry, ...]:
    """Two paths that differ only by case would overwrite each other when unzipped on Windows."""
    seen: dict[str, TreePath] = {}
    for entry in entries:
        key = entry.path.casefold()
        if key in seen:
            raise ValueError(f"Two files in the upload share a path: {seen[key]} and {entry.path}")
        seen[key] = entry.path
    return entries


def _folder_name(paths: Sequence[TreePath]) -> str:
    tops = {path.split("/", 1)[0] for path in paths}
    if len(tops) == 1 and all("/" in path for path in paths):
        return _container_name(tops.pop())
    stems = [PurePosixPath(path).name.split(".", 1)[0] for path in paths]
    tokens = [stem.split("_") for stem in stems]
    shared: list[str] = []
    for column in zip(*tokens):
        if len(set(column)) != 1:
            break
        shared.append(column[0])
    return "_".join(shared) or "station"


def _gdb_root(path: TreePath) -> TreePath | None:
    """The outermost folder named ``*.gdb`` holding this entry; None outside a geodatabase."""
    segments = path.rstrip("/").split("/")
    for depth, segment in enumerate(segments[:-1]):
        if segment.lower().endswith(".gdb"):
            return TreePath("/".join(segments[: depth + 1]))
    return None


def _is_lock_file(entry: TreeEntry) -> bool:
    """ArcGIS leaves ``*.sr.lock`` files in a .gdb (Tokyo's held 1,057 of 3,022 files); a copy is locked by none of them."""
    return entry.data is not None and entry.path.lower().endswith(".lock") and _gdb_root(entry.path) is not None


def _write_zip(tree: FileTree, replaced: Mapping[TreePath, bytes]) -> bytes:
    """Entries in tree order; ``replaced`` supplies the data for the paths it names, nothing else changes.

    Names are written as UTF-8 with the zip UTF-8 flag, so a cp932-named
    archive comes back with the same names in a different encoding.
    """
    now = time.localtime()[:6]
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for entry in tree.entries:
            source = entry.source
            info = zipfile.ZipInfo(entry.path, date_time=source.date_time if source else now)
            if source is not None:
                info.external_attr = source.external_attr
                info.compress_type = source.compress_type
            else:
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
            if entry.data is None:
                info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, b"")
            else:
                archive.writestr(info, replaced.get(entry.path, entry.data))
    return buffer.getvalue()


@dataclass(frozen=True, slots=True)
class _Table:
    table: DbfTable
    field: DbfField
    codec: str


@dataclass(frozen=True, slots=True)
class _Geodatabase:
    path: TreePath
    directory: Path
    """Its files, written out under the workspace."""
    python: Path
    """The interpreter that read it, and so the one that updates it."""
    layers: tuple[str, ...]
    """Ids of the layers read from it, each ``<path>/<layer name>``."""


@dataclass(frozen=True, slots=True)
class _Survey:
    tree: FileTree
    """The upload without its lock files."""
    dataset: DatasetInfo
    tables: Mapping[str, _Table]
    geodatabases: tuple[_Geodatabase, ...]
    """The ones that were read; none without a GDAL Python."""
    symbology: Mapping[TreePath, bytes]
    """Layer files and projects with a rewritten renderer, as they come back."""
    plan: ThemePlan


def _survey(
    theme: ColorTheme,
    blobs: Sequence[tuple[str, bytes]],
    *,
    max_bytes: int,
    gdal_python: Path | None,
    workspace: Path,
) -> _Survey:
    """The tree, then one layer per DBF and per geodatabase layer that names the theme's field, then the plan.

    A .dbf whose header does not add up is reported ``unreadable``: it might
    have carried the field, and the operator should hear about it. A .dbf
    without the field is not a layer. A geodatabase is either read whole or
    reported as one ``gdb_unavailable`` or ``unreadable`` entry.
    """
    uploaded = _tree_from_upload(blobs, max_bytes=max_bytes)
    tree = replace(uploaded, entries=tuple(entry for entry in uploaded.entries if not _is_lock_file(entry)))
    files = {entry.path.casefold(): entry.data for entry in tree.entries if entry.data is not None}
    in_gdb = [root for entry in tree.entries if entry.data is not None and (root := _gdb_root(entry.path)) is not None]
    roots = list(dict.fromkeys(in_gdb))
    tables: dict[str, _Table] = {}
    layers: list[LayerInput | SkippedLayer] = []
    for entry in tree.entries:
        if entry.data is None or not entry.path.lower().endswith(".dbf") or _gdb_root(entry.path) is not None:
            continue
        try:
            table = DbfTable.parse(entry.data)
        except DbfLayoutError:
            layers.append(SkippedLayer(id=entry.path, reason="unreadable"))
            continue
        field = table.field(theme.field)
        if field is None:
            continue
        if field.type != "C":
            layers.append(SkippedLayer(id=entry.path, reason="field_not_text"))
            continue
        layer = _layer(theme, entry.path, table, field, files.get(entry.path[:-4].casefold() + ".cpg"))
        tables[entry.path] = _Table(table=table, field=field, codec=layer.encoding.codec)
        layers.append(layer)
    geodatabases: list[_Geodatabase] = []
    for number, root in enumerate(roots):
        if gdal_python is None:
            layers.append(SkippedLayer(id=root, reason="gdb_unavailable"))
            continue
        directory = workspace / f"{number}.gdb"
        read = _read_geodatabase(theme, tree, root, directory, gdal_python)
        layers += read
        ids = tuple(layer.id for layer in read if isinstance(layer, LayerInput))
        geodatabases.append(_Geodatabase(path=root, directory=directory, python=gdal_python, layers=ids))
    symbology: list[SymbologyLine] = []
    rewritten: dict[TreePath, bytes] = {}
    # One allowance for every project in the upload, or many small ones could each inflate to the whole limit.
    remaining = max_bytes
    for entry in tree.entries:
        kind = _symbology_kind(entry.path)
        if entry.data is None or kind is None or _gdb_root(entry.path) is not None:
            continue
        line, data = _retheme_file(theme, entry.path, entry.data, kind, max_bytes=remaining)
        if kind == "aprx":
            remaining -= _expanded_size(entry.data)
        symbology.append(line)
        if data is not None:
            rewritten[entry.path] = data
    dataset = DatasetInfo(
        name=tree.name,
        download_name=f"{tree.name}{DOWNLOAD_SUFFIX}.zip",
        files=sum(1 for entry in tree.entries if entry.data is not None),
        geodatabases=len(roots),
        lock_files_dropped=len(uploaded.entries) - len(tree.entries),
    )
    return _Survey(
        tree=tree,
        dataset=dataset,
        tables=tables,
        geodatabases=tuple(geodatabases),
        symbology=rewritten,
        plan=plan(theme, layers, symbology),
    )


def _read_geodatabase(
    theme: ColorTheme, tree: FileTree, root: TreePath, directory: Path, python: Path
) -> list[LayerInput | SkippedLayer]:
    prefix = f"{root}/"
    try:
        for entry in tree.entries:
            if entry.data is not None and entry.path.startswith(prefix):
                target = directory / entry.path.removeprefix(prefix)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(entry.data)
    except OSError:
        # A name Windows will not create (CON, a trailing dot) cannot be a geodatabase file anyway.
        return [SkippedLayer(id=root, reason="unreadable")]
    return read_layers(directory, root, theme, python)


def _reloaded(tree: FileTree, gdb: _Geodatabase) -> FileTree:
    """``tree`` with the geodatabase's entries read back from its folder after an update.

    A file still there keeps its position and zip date, a file GDAL added
    follows the geodatabase's last entry, and a file GDAL removed is dropped.
    """
    prefix = f"{gdb.path}/"
    on_disk = {
        file.relative_to(gdb.directory).as_posix(): file for file in sorted(gdb.directory.rglob("*")) if file.is_file()
    }
    unclaimed = {name.casefold(): name for name in on_disk}
    entries: list[TreeEntry] = []
    after_last = 0
    for entry in tree.entries:
        if not entry.path.startswith(prefix):
            entries.append(entry)
            continue
        name = unclaimed.pop(entry.path.removeprefix(prefix).casefold(), None)
        if entry.data is None:
            entries.append(entry)
        elif name is not None:
            entries.append(replace(entry, data=on_disk[name].read_bytes()))
        after_last = len(entries)
    added = [
        TreeEntry(path=TreePath(prefix + name), data=on_disk[name].read_bytes(), source=None) for name in unclaimed.values()
    ]
    return replace(tree, entries=(*entries[:after_last], *added, *entries[after_last:]))


def _layer(theme: ColorTheme, path: str, table: DbfTable, field: DbfField, cpg: bytes | None) -> LayerInput:
    """The decode side of the boundary: resolve the codec once, decode the target and category of every live row."""
    codec = resolve_codec(table, cpg)
    category_field = table.field(theme.category_field)
    rows = []
    for row in table.live_rows():
        value = _decode(table.text(row, field), codec.name)
        category = None if category_field is None else _decode(table.text(row, category_field), codec.name)
        # None means "no category" to the planner, which would then apply a default rule the code may override.
        if category_field is not None and category is None:
            value = None
        rows.append(Row(index=row, value=value, category=category))
    return LayerInput(
        id=path, rows=rows, width=field.width, width_unit="bytes", encoding=Encoding(codec.name, codec.source)
    )


def _decode(raw: bytes, codec: str) -> str | None:
    try:
        return raw.decode(codec)
    except UnicodeDecodeError:
        return None


def _patch(table: _Table, edits: Mapping[int, str]) -> bytes:
    """The encode side of the boundary, and the only write."""
    return table.table.with_text(table.field, {row: value.encode(table.codec) for row, value in edits.items()})


_BOM = b"\xef\xbb\xbf"
_SYMBOLOGY_SUFFIXES: dict[str, SymbologyKind] = {".lyrx": "lyrx", ".aprx": "aprx"}


def _symbology_kind(path: str) -> SymbologyKind | None:
    return _SYMBOLOGY_SUFFIXES.get(PurePosixPath(path).suffix.lower())


def _retheme_file(
    theme: ColorTheme, path: str, data: bytes, kind: SymbologyKind, *, max_bytes: int
) -> tuple[SymbologyLine, bytes | None]:
    """The report line, and the file as it comes back when a renderer was rewritten. An unreadable file passes through."""
    try:
        if kind == "lyrx":
            renderers, rewritten = _retheme_lyrx(theme, data)
        else:
            renderers, rewritten = _retheme_aprx(theme, data, max_bytes=max_bytes)
    except ValueError:
        return SymbologyLine(path=path, kind=kind, unreadable=True, renderers=()), None
    return SymbologyLine(path=path, kind=kind, unreadable=False, renderers=tuple(renderers)), rewritten


def _parse_json(data: bytes) -> tuple[bytes, Any]:
    """The leading BOM, if any, and the document. ValueError covers bad UTF-8 and bad JSON."""
    bom = _BOM if data.startswith(_BOM) else b""
    return bom, json.loads(data[len(bom) :].decode("utf-8"))


def _any_rewritten(changes: Sequence[RendererChange]) -> bool:
    return any(change.outcome == "rewritten" for change in changes)


def _retheme_lyrx(theme: ColorTheme, data: bytes) -> tuple[list[RendererChange], bytes | None]:
    bom, doc = _parse_json(data)
    changes = retheme_document(doc, theme)
    if not _any_rewritten(changes):
        return changes, None
    # Pro's own layout for a layer file; JSON escapes any newline inside a string, so only the layout's change.
    text = json.dumps(doc, ensure_ascii=False, indent=2, separators=(",", " : ")).replace("\n", "\r\n")
    return changes, bom + text.encode("utf-8")


def _expanded_size(project: bytes) -> int:
    """What the project declares it inflates to; a project that then fails to read has still cost that much."""
    try:
        with zipfile.ZipFile(BytesIO(project)) as archive:
            return sum(info.file_size for info in archive.infolist())
    except (zipfile.BadZipFile, zipfile.LargeZipFile):
        return 0


def _retheme_aprx(theme: ColorTheme, data: bytes, *, max_bytes: int) -> tuple[list[RendererChange], bytes | None]:
    """Each member that holds a renderer naming the field is rethemed; the rest are carried over as they are."""
    marker, field = b'"CIMUniqueValueRenderer"', theme.field.lower().encode("utf-8")
    changes: list[RendererChange] = []
    members: list[tuple[zipfile.ZipInfo, bytes]] = []
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            infos = archive.infolist()
            if sum(info.file_size for info in infos) > max_bytes:
                raise ValueError(EXPANDED_LIMIT_MESSAGE)
            comment = archive.comment
            for info in infos:
                member = archive.read(info)
                if marker in member and field in member.lower():
                    found, member = _retheme_member(theme, info.filename, member)
                    changes += found
                members.append((info, member))
    except (zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error, RuntimeError, NotImplementedError, EOFError) as exc:
        raise ValueError(f"Not a readable project: {exc}") from exc
    if not _any_rewritten(changes):
        return changes, None
    return changes, _write_project(members, comment)


def _retheme_member(theme: ColorTheme, name: str, member: bytes) -> tuple[list[RendererChange], bytes]:
    try:
        bom, doc = _parse_json(member)
    except ValueError:
        unreadable = RendererChange(
            layer=name, outcome="left_alone", reason="unreadable", classes_before=0, classes_after=0, areas=(), kept=()
        )
        return [unreadable], member
    changes = retheme_document(doc, theme)
    if not _any_rewritten(changes):
        return changes, member
    # Pro saves project members as compact JSON.
    return changes, bom + json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _write_project(members: Sequence[tuple[zipfile.ZipInfo, bytes]], comment: bytes) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.comment = comment
        for source, data in members:
            info = zipfile.ZipInfo(source.filename, date_time=source.date_time)
            info.compress_type = source.compress_type
            info.external_attr = source.external_attr
            info.create_system = source.create_system
            info.comment = source.comment
            archive.writestr(info, data)
    return buffer.getvalue()
