"""Shared pieces of the hand-written QGIS project files.

Two exports emit ``.qgs`` XML without PyQGIS: the Illustrator GeoPackage
projects (:mod:`backend.src.illustrator_qgis`) and the Open Data Contest
shapefile projects (:mod:`backend.src.odc_qgis`).

The CRS declaration lives here because it is the part QGIS silently drops when
it is written incompletely: ``<projectCrs>`` is parsed and then discarded
unless ``<properties>`` also switches projections on. :func:`project_document`
therefore writes both, so neither export can name a CRS that QGIS ignores.
"""

from __future__ import annotations

from functools import lru_cache
from xml.sax.saxutils import escape, quoteattr

QGIS_VERSION = "3.34.0"

UNKNOWN_SRS = (
    "<spatialrefsys nativeFormat=\"Wkt\">"
    "<wkt></wkt><proj4></proj4><srsid>0</srsid><srid>0</srid>"
    "<authid></authid><description></description>"
    "<projectionacronym></projectionacronym><ellipsoidacronym></ellipsoidacronym>"
    "<geographicflag>false</geographicflag>"
    "</spatialrefsys>"
)


@lru_cache(maxsize=16)
def srs_xml(crs: str | None) -> str:
    """A QGIS ``<spatialrefsys>`` block for ``crs``, or the unknown-CRS block."""
    if not crs:
        return UNKNOWN_SRS

    from pyproj import CRS as _PyprojCRS  # local import keeps module import cheap

    parsed = _PyprojCRS.from_user_input(crs)
    authority = parsed.to_authority()
    authid = f"{authority[0]}:{authority[1]}" if authority else crs
    srid = authority[1] if authority else "0"
    return (
        '<spatialrefsys nativeFormat="Wkt">'
        f"<wkt>{escape(parsed.to_wkt())}</wkt><proj4>{escape(parsed.to_proj4())}</proj4>"
        f"<srsid>{escape(str(srid))}</srsid><srid>{escape(str(srid))}</srid>"
        f"<authid>{escape(authid)}</authid>"
        f"<description>{escape(parsed.name)}</description>"
        "<projectionacronym></projectionacronym><ellipsoidacronym></ellipsoidacronym>"
        f"<geographicflag>{'true' if parsed.is_geographic else 'false'}</geographicflag>"
        "</spatialrefsys>"
    )


@lru_cache(maxsize=16)
def map_units(crs: str | None) -> str:
    """The canvas ``<units>`` for ``crs``: degrees for a geographic CRS.

    Only the two units the exports use are distinguished; a CRS in feet would
    still be reported as metres, and nothing here emits one.
    """
    if not crs:
        return "unknown"

    from pyproj import CRS as _PyprojCRS

    return "degrees" if _PyprojCRS.from_user_input(crs).is_geographic else "meters"


def project_document(project_name: str, crs: str | None, body: str) -> str:
    """A complete ``.qgs`` document: the CRS declaration, then ``body``.

    ``body`` supplies the layer tree, ``<projectlayers>`` and ``<layerorder>``.

    QGIS reads ``<projectCrs>`` only when projections are switched on in the
    legacy ``<properties>`` block. Without it the CRS below is parsed and then
    silently discarded, and the project opens with no CRS - which is why every
    export had to have its CRS set by hand. Established by loading the
    generated file in QGIS 3.42 via PyQGIS: with the flag at 1 the project
    reports its authority code, with it at 0, or with ``<properties>`` absent,
    it reports an empty authid. Nothing else from QGIS's much larger
    ``<properties>`` block is needed, and no ``<mapcanvas>``/
    ``<destinationsrs>`` is needed either.

    The flag stays off without a CRS, so ungeoreferenced output keeps declaring
    an unknown CRS rather than claiming a bogus one.
    """
    properties = (
        "<properties><SpatialRefSys>"
        f"<ProjectionsEnabled type=\"int\">{'1' if crs else '0'}</ProjectionsEnabled>"
        "</SpatialRefSys></properties>"
    )
    return (
        "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>"
        f"<qgis version=\"{QGIS_VERSION}\" projectname={quoteattr(project_name)}>"
        f"{properties}"
        f"<projectCrs>{srs_xml(crs)}</projectCrs>"
        f"{body}"
        "</qgis>"
    )
