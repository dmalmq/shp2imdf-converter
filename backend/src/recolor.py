"""Apply the colour theme to one uploaded station. Every file comes back; only ``color2`` bytes change.

The upload becomes a ``FileTree``: relative path to bytes, in upload order.
Each ``.dbf`` in it that carries the theme's field is decoded here (the one
decode/encode boundary), planned by ``color_theme.plan`` and patched by
``DbfTable.with_text``. Every other entry is carried over as it came. No
geometry is opened, so PolygonZM measures, .prj text and spatial indexes
cannot drift.

``inspect`` and ``convert`` share one private pass, so the report the
operator checks and the archive they download come from the same plan.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
import re
import time
from typing import NewType
import zipfile

from backend.src.color_theme import (
    ColorTheme,
    Encoding,
    LayerInput,
    Row,
    SkippedLayer,
    ThemePlan,
    ThemeReport,
    plan,
)
from backend.src.dbf_table import DbfField, DbfLayoutError, DbfTable, resolve_codec
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
    """Every file in the upload, including the ones that come back untouched."""


@dataclass(frozen=True, slots=True)
class Inspection:
    dataset: DatasetInfo
    theme: ThemeReport


@dataclass(frozen=True, slots=True)
class Archive:
    filename: str
    data: bytes


def inspect(theme: ColorTheme, blobs: Sequence[tuple[str, bytes]], *, max_bytes: int) -> Inspection:
    """What converting this upload would change. Writes nothing anywhere."""
    survey = _survey(theme, blobs, max_bytes=max_bytes)
    return Inspection(dataset=_dataset(survey.tree), theme=survey.plan.report)


def convert(theme: ColorTheme, blobs: Sequence[tuple[str, bytes]], *, max_bytes: int) -> Archive:
    """The upload as a zip with the theme applied: same entries, same order, same bytes but the edits.

    Converting a converted upload finds every value already new and returns
    the same entries with the same bytes.
    """
    survey = _survey(theme, blobs, max_bytes=max_bytes)
    replaced = {path: _patch(survey.tables[path], edits) for path, edits in survey.plan.edits.items()}
    return Archive(filename=_dataset(survey.tree).download_name, data=_write_zip(survey.tree, replaced))


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


def _dataset(tree: FileTree) -> DatasetInfo:
    return DatasetInfo(
        name=tree.name,
        download_name=f"{tree.name}{DOWNLOAD_SUFFIX}.zip",
        files=sum(1 for entry in tree.entries if entry.data is not None),
    )


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
class _Survey:
    tree: FileTree
    tables: Mapping[str, _Table]
    plan: ThemePlan


def _survey(theme: ColorTheme, blobs: Sequence[tuple[str, bytes]], *, max_bytes: int) -> _Survey:
    """The tree, then one layer per DBF that names the theme's field, then the plan.

    A .dbf whose header does not add up is reported ``unreadable``: it might
    have carried the field, and the operator should hear about it. A .dbf
    without the field is not a layer.
    """
    tree = _tree_from_upload(blobs, max_bytes=max_bytes)
    files = {entry.path.casefold(): entry.data for entry in tree.entries if entry.data is not None}
    tables: dict[str, _Table] = {}
    layers: list[LayerInput | SkippedLayer] = []
    for entry in tree.entries:
        if entry.data is None or not entry.path.lower().endswith(".dbf"):
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
    return _Survey(tree=tree, tables=tables, plan=plan(theme, layers))


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
    return LayerInput(id=path, rows=rows, width=field.width, encoding=Encoding(codec.name, codec.source))


def _decode(raw: bytes, codec: str) -> str | None:
    try:
        return raw.decode(codec)
    except UnicodeDecodeError:
        return None


def _patch(table: _Table, edits: Mapping[int, str]) -> bytes:
    """The encode side of the boundary, and the only write."""
    return table.table.with_text(table.field, {row: value.encode(table.codec) for row, value in edits.items()})
