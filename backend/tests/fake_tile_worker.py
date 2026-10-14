"""Stands in for ``build_tiles.py`` in tests: the same JSON lines and a small ``.vtiles`` tree, without arcpy.

Run as ``python -I fake_tile_worker.py <project> <upload root> <out dir> <layers.json>``.
What it does is read from the project's ``fake_plan.json`` member, when it has one:
``expects`` lists paths that must sit under the upload root, ``gate`` names a
file to wait for after step 1, ``fail`` is a reason to fail with there,
``hang`` never finishes, ``pid`` names a file to write its process id to, and
``problems`` are passed through in the result. It logs the layers it was told
to tile and warns about empty groups as the real worker does.
"""

import json
import os
from pathlib import Path
import sys
import time
import zipfile


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def fail(reason):
    emit("failed", reason=reason)
    print(reason, file=sys.stderr, flush=True)
    sys.exit(1)


project, root, out, layers = (Path(arg) for arg in sys.argv[1:5])
with zipfile.ZipFile(project) as aprx:
    plan = json.loads(aprx.read("fake_plan.json")) if "fake_plan.json" in aprx.namelist() else {}
if plan.get("pid"):
    Path(plan["pid"]).write_text(str(os.getpid()), encoding="utf-8")
print("arcpy prose that is not JSON", flush=True)
for expected in plan.get("expects", []):
    if not (root / expected).is_file():
        fail(f"missing {expected}")
visibility = json.loads(layers.read_text(encoding="utf-8"))["layers"]
emit("message", text="Tiled: " + ", ".join(line["name"] for line in visibility if line["visible"] and not line["group"]))
empty = [line["name"] for line in visibility if line["group"] and not line["visible"]]
if empty:
    emit("warning", text="These groups have no layer chosen and are switched off: " + ", ".join(empty))
emit("step", step=1, of=5, label="Create Vector Tile Index (5000 vertices)")
if plan.get("gate"):
    deadline = time.monotonic() + 60
    while not Path(plan["gate"]).exists() and time.monotonic() < deadline:
        time.sleep(0.02)
if plan.get("hang"):
    time.sleep(600)
if plan.get("fail"):
    print("Traceback: something arcpy said", file=sys.stderr, flush=True)
    fail(plan["fail"])
for step, label in enumerate(("Map metadata", "Create Vector Tile Package", "Extract Package", "root.json"), start=2):
    emit("step", step=step, of=5, label=label)
vtiles = out / "tiles" / "p12" / f"{project.stem}.vtiles"
(vtiles / "resources" / "styles").mkdir(parents=True)
(vtiles / "resources" / "styles" / "root.json").write_bytes(b'{"sources":{"esri":{"maxzoom":16}}}')
for z in range(15, 22):
    (vtiles / "tile" / str(z) / "0").mkdir(parents=True)
    (vtiles / "tile" / str(z) / "0" / "0.pbf").write_bytes(bytes([z]) * 3)
emit("result", vtiles=str(vtiles), problems=plan.get("problems", []))
