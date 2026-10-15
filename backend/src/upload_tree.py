"""Relative paths in an upload, and where File Geodatabases sit among them.

Shared by the colour tool and the standard import. A geodatabase is a folder
named ``*.gdb``; everything under it belongs to it, so its files are only
meaningful together and under their own names.
"""

from __future__ import annotations

import re
from typing import NewType

TreePath = NewType("TreePath", str)
"""Relative POSIX path: no drive, no leading slash, no ``.`` or ``..`` segments. Directories end in ``/``."""

_DRIVE = re.compile(r"^[A-Za-z]:")


def tree_path(raw: str) -> TreePath:
    """Normalise the forms browsers report (``/Folder/a.dbf``, ``./a.dbf``); refuse anything that could escape."""
    path = raw.replace("\\", "/")
    if path.startswith("//") or _DRIVE.match(path) or any(ord(ch) < 0x20 for ch in path):
        raise ValueError(f"Unsafe path in upload: {raw!r}")
    segments = [segment for segment in path.split("/") if segment not in ("", ".")]
    if not segments or ".." in segments:
        raise ValueError(f"Unsafe path in upload: {raw!r}")
    return TreePath("/".join(segments) + ("/" if path.endswith("/") else ""))


def gdb_root(path: str) -> TreePath | None:
    """The outermost folder named ``*.gdb`` holding this entry; None outside a geodatabase."""
    segments = path.rstrip("/").split("/")
    for depth, segment in enumerate(segments[:-1]):
        if segment.lower().endswith(".gdb"):
            return TreePath("/".join(segments[: depth + 1]))
    return None


def is_gdb_lock_file(path: str) -> bool:
    """ArcGIS leaves ``*.sr.lock`` files in a .gdb (Tokyo's held 1,057 of 3,022 files); a copy is locked by none of them."""
    return path.lower().endswith(".lock") and gdb_root(path) is not None
