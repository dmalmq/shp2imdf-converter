"""Raw dBASE bytes: read text fields, rewrite them in place, decide their encoding. No GDAL.

A geopandas read-write of a DBF changes field widths and numeric types and
rewrites the encoding. Here a table is its original bytes plus a parsed
header, and the only write is a same-width replacement inside one field of
named live records. The header, the other fields, the deletion flags and the
EOF marker stay the input's bytes because no code path addresses them.
"""

from __future__ import annotations

import codecs
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Literal

_DELETED = 0x2A
_TERMINATOR = 0x0D


class DbfLayoutError(ValueError):
    """The header does not describe the bytes, so the table is passed through, never edited."""


@dataclass(frozen=True, slots=True)
class DbfField:
    name: str
    type: str
    """dBASE type letter: "C", "N", "D", "L", "F", ..."""
    offset: int
    """From the start of a record; byte 0 is the deletion flag, so the first field is at 1."""
    width: int


@dataclass(frozen=True, slots=True)
class DbfTable:
    data: bytes
    header_length: int
    record_length: int
    record_count: int
    language_driver: int
    fields: tuple[DbfField, ...]

    @classmethod
    def parse(cls, data: bytes) -> DbfTable:
        """Read the header; raise DbfLayoutError unless it accounts for the bytes exactly."""
        if len(data) < 33:
            raise DbfLayoutError("shorter than a dBASE header")
        record_count = int.from_bytes(data[4:8], "little")
        header_length = int.from_bytes(data[8:10], "little")
        record_length = int.from_bytes(data[10:12], "little")
        fields: list[DbfField] = []
        offset = 1
        position = 32
        while True:
            if position >= min(header_length, len(data)):
                raise DbfLayoutError("field descriptors run past the header")
            if data[position] == _TERMINATOR:
                break
            if position + 32 > header_length:
                raise DbfLayoutError("field descriptor cut off by the header length")
            descriptor = data[position : position + 32]
            kind = chr(descriptor[11])
            width = descriptor[16]
            name = descriptor[:11].split(b"\x00", 1)[0].decode("ascii", errors="replace")
            fields.append(DbfField(name=name, type=kind, offset=offset, width=width))
            offset += width
            position += 32
        if offset != record_length:
            raise DbfLayoutError(f"fields cover {offset} bytes but a record is {record_length}")
        if header_length + record_count * record_length > len(data):
            raise DbfLayoutError("fewer bytes than the header's records need")
        return cls(
            data=data,
            header_length=header_length,
            record_length=record_length,
            record_count=record_count,
            language_driver=data[29],
            fields=tuple(fields),
        )

    def field(self, name: str) -> DbfField | None:
        wanted = name.casefold()
        return next((field for field in self.fields if field.name.casefold() == wanted), None)

    def live_rows(self) -> Iterator[int]:
        for row in range(self.record_count):
            if self.data[self._start(row)] != _DELETED:
                yield row

    def text(self, row: int, field: DbfField) -> bytes:
        """The field's bytes with trailing spaces and NULs stripped, as GDAL and ArcGIS show them."""
        start = self._start(row) + field.offset
        return self.data[start : start + field.width].rstrip(b" \x00")

    def with_text(self, field: DbfField, values: Mapping[int, bytes]) -> bytes:
        """A copy of the table where each named row's field holds its value, left-aligned and space-padded.

        Raises ValueError rather than truncate, or write a deleted row or a non-text field.
        """
        if field.type != "C":
            raise ValueError(f"{field.name} is not a text field")
        buffer = bytearray(self.data)
        for row, value in values.items():
            if not 0 <= row < self.record_count:
                raise ValueError(f"row {row} is outside the table")
            start = self._start(row)
            if buffer[start] == _DELETED:
                raise ValueError(f"row {row} is deleted")
            if len(value) > field.width:
                raise ValueError(f"{len(value)} bytes do not fit {field.name} C({field.width})")
            start += field.offset
            buffer[start : start + field.width] = value.ljust(field.width, b" ")
        return bytes(buffer)

    def _start(self, row: int) -> int:
        return self.header_length + row * self.record_length


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


_LANGUAGE_DRIVERS: Mapping[int, str] = {0x13: "cp932"}
"""Only the driver seen in Japanese CAD/GIS exports; anything else falls through to sniffing."""


@dataclass(frozen=True, slots=True)
class Codec:
    name: str
    source: Literal["cpg", "ldid", "sniffed", "ascii"]


def resolve_codec(table: DbfTable, cpg: bytes | None) -> Codec:
    """The encoding of one table: its .cpg, else its language driver, else sniffed, else ASCII.

    A wrong answer cannot corrupt data: text decoded with the wrong codec
    matches no old value, so its row is reported and left alone.
    """
    if cpg is not None and (name := cpg_codec(cpg)):
        return Codec(name, "cpg")
    if name := _LANGUAGE_DRIVERS.get(table.language_driver):
        return Codec(name, "ldid")
    records = table.data[: table.header_length + table.record_count * table.record_length]
    if name := sniff_codec(record_text(records), final=True):
        return Codec(name, "sniffed")
    return Codec("ascii", "ascii")
