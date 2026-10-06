"""Raw dBASE bytes: the text a table holds and the encoding it was written in. No GDAL."""

from __future__ import annotations

import codecs


def record_text(dbf: bytes) -> bytes:
    """Field names plus record bytes, tolerant of a sample cut off mid-table."""
    if len(dbf) < 32:
        return b""
    header_length = int.from_bytes(dbf[8:10], "little")
    field_names = [
        dbf[offset : offset + 11].split(b"\x00", 1)[0]
        for offset in range(32, header_length - 1, 32)
        if dbf[offset] != 0x0D
    ]
    return b"".join(field_names) + dbf[header_length:].rstrip(b"\x1a")


def cpg_codec(cpg: bytes) -> str | None:
    """The Python codec a .cpg names ("UTF-8", "932", "ANSI 932", "8859_1", "SJIS"), or None."""
    label = cpg.decode("ascii", errors="ignore").strip()
    if label.upper().startswith("ANSI "):
        label = label[5:].strip()
    if label.isdigit():
        label = f"cp{label}"
    elif label.startswith("8859"):
        label = f"iso{label}"
    try:
        return codecs.lookup(label).name
    except LookupError:
        return None


def sniff_codec(text: bytes, *, final: bool) -> str | None:
    """UTF-8, else cp932, whichever decodes ``text``; None for pure ASCII or neither.

    ``final=False`` for a sample that may end mid-character.
    """
    if text.isascii():
        return None
    for encoding in ("utf-8", "cp932"):
        try:
            codecs.getincrementaldecoder(encoding)().decode(text, final=final)
        except UnicodeDecodeError:
            continue
        return encoding
    return None
