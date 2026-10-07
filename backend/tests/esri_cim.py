"""Esri's own CIM deserializer, from ArcGIS Pro's ArcGIS.Core.dll, run through PowerShell 7. Needs no licence.

It also accepts unknown properties and a value listed in two classes, so it
proves that Pro can parse a document, not that the document is right.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

ARCGIS_CORE = Path(os.getenv("ProgramFiles", r"C:\Program Files")) / "ArcGIS" / "Pro" / "bin" / "ArcGIS.Core.dll"
PWSH = shutil.which("pwsh")
SCRIPT = Path(__file__).with_name("cim_parse.ps1")
AVAILABLE = ARCGIS_CORE.is_file() and PWSH is not None
SKIP_REASON = "needs ArcGIS Pro's ArcGIS.Core.dll and PowerShell 7"


def esri_read(path: Path, field: str = "color2") -> dict[str, Any]:
    """``{"layers": [{name, fields, classes: [{label, values, layers, fill, stroke}]}], "failed": [member, ...]}``.

    From a project, the layers whose renderer is keyed on ``field`` alone. Raises CalledProcessError when a
    layer file does not parse.
    """
    done = subprocess.run(
        [str(PWSH), "-NoProfile", "-NonInteractive", "-File", str(SCRIPT), str(ARCGIS_CORE), str(path), field],
        capture_output=True,
        check=True,
        timeout=600,
    )
    return json.loads(done.stdout.decode("utf-8"))
