"""Compare two export folders entry by entry.

    python tools/compare_exports.py <before> <after>

Used to show that a UI change leaves every download the same: export each
format from the same project before and after, save each download as
`<format>__<download name>`, and compare. Exit status 1 on any difference.

Each folder holds `<format>__<download name>` files. Zips (and zips inside
them, such as the .qgz) are compared by the SHA-256 of every entry. Two fields
are known to carry the export time and are masked before hashing:
manifest.json "created", and a .dbf header's last-update date (bytes 1-3).
The QGIS .qgs is not reproducible even from one commit: QGIS writes
attributes in hash order, fresh layer UUIDs (which also order the snapping
settings list), a random styles.db name, its save and creation times, and
random colours for layers it has no style for. It is compared as canonical
XML with attributes sorted and those values masked; element order is kept,
so a change to the layer tree or layer order is caught, except in the one
list QGIS orders by UUID. The styles.db entry is matched under a masked name.
Any other difference is reported as a byte difference.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


_UUID = re.compile(r"[0-9a-f]{8}[_-][0-9a-f]{4}[_-][0-9a-f]{4}[_-][0-9a-f]{4}[_-][0-9a-f]{12}")
_STYLES_DB = re.compile(r"[A-Za-z]{6}_styles\.db")
_ORDERED_BY_UUID = {"individual-layer-settings"}
_TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")
_COLOUR = re.compile(r"^\d+,\d+,\d+,\d+(,rgb:[0-9.,]+)?$")


def _canonical_xml(element: ET.Element) -> str:
    def clean(value: str | None) -> str:
        text = _UUID.sub("<uuid>", (value or "").strip())
        return _STYLES_DB.sub("<db>", _TIME.sub("<time>", text))

    attrs = {k: clean(v) for k, v in element.attrib.items() if k != "saveDateTime"}
    if _COLOUR.match(attrs.get("value", "")):
        attrs["value"] = "<colour>"
    children = [_canonical_xml(child) for child in element]
    # QGIS lists snapping settings by layer id, which carries a fresh UUID, so
    # only that list has no stable order. Every other list, the layer tree
    # included, is compared in the order it was written.
    if element.tag in _ORDERED_BY_UUID:
        children.sort()
    inner = "".join(children)
    return f"<{element.tag} {sorted(attrs.items())}>{clean(element.text)}{inner}</{element.tag}>{clean(element.tail)}"


def _entry_name(name: str) -> str:
    return _STYLES_DB.sub("<db>", name)


def _mask(name: str, data: bytes) -> tuple[bytes, bool]:
    if name.endswith(".qgs"):
        # QGIS writes attributes in hash order and fresh layer UUIDs, a
        # random styles.db name and the save time on every run.
        return _canonical_xml(ET.fromstring(data)).encode(), True
    if name.endswith("manifest.json"):
        doc = json.loads(data)
        if "created" in doc:
            doc["created"] = "<masked>"
            return json.dumps(doc, sort_keys=True).encode(), True
    if name.lower().endswith(".dbf") and len(data) > 4:
        return data[:1] + b"\0\0\0" + data[4:], True
    return data, False


def entries(data: bytes, prefix: str = "") -> dict[str, tuple[str, str, bool]]:
    out: dict[str, tuple[str, str, bool]] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            raw = archive.read(info)
            name = prefix + _entry_name(info.filename)
            if info.filename.lower().endswith((".zip", ".qgz")):
                out.update(entries(raw, name + "!"))
                continue
            masked, touched = _mask(name, raw)
            out[name] = (hashlib.sha256(raw).hexdigest(), hashlib.sha256(masked).hexdigest(), touched)
    return out


def by_format(folder: Path) -> dict[str, Path]:
    return {p.name.split("__", 1)[0]: p for p in folder.iterdir() if "__" in p.name}


def main(before: Path, after: Path) -> int:
    left, right = by_format(before), by_format(after)
    failed = False
    for fmt in sorted(set(left) | set(right)):
        if fmt not in left or fmt not in right:
            print(f"{fmt}: MISSING in {'before' if fmt not in left else 'after'}")
            failed = True
            continue
        a, b = entries(left[fmt].read_bytes()), entries(right[fmt].read_bytes())
        names_a, names_b = left[fmt].name.split("__", 1)[1], right[fmt].name.split("__", 1)[1]
        raw_same = sum(1 for k in a if k in b and a[k][0] == b[k][0])
        masked_only = [k for k in a if k in b and a[k][0] != b[k][0] and a[k][1] == b[k][1]]
        differ = [k for k in a if k in b and a[k][1] != b[k][1]]
        missing = sorted(set(a) ^ set(b))
        ok = not differ and not missing and names_a == names_b
        failed |= not ok
        print(
            f"{fmt}: {'SAME' if ok else 'DIFFERENT'} | download {names_a}"
            + ("" if names_a == names_b else f" -> {names_b}")
            + f" | {len(a)} entries, {raw_same} byte-identical, {len(masked_only)} differ only in masked run-to-run fields"
            + (f" ({', '.join(sorted(masked_only))})" if masked_only else "")
        )
        for k in differ:
            print(f"    differs: {k}")
        for k in missing:
            print(f"    only in {'before' if k in a else 'after'}: {k}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
