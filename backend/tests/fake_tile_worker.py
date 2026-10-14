"""Stands in for ``build_tiles.py`` in tests: the same JSON lines and a small ``.vtiles`` tree, without arcpy.

Run as ``python -I fake_tile_worker.py <project> <upload root> <out dir>``.
What it does is read from the project file, which is JSON here, not a zip:
``expects`` lists paths that must sit under the upload root, ``gate`` names a
file to wait for after step 1, ``fail`` is a reason to fail with there,
``hang`` never finishes, and ``problems`` are passed through in the result.
"""

import json
from pathlib import Path
import sys
import time


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def fail(reason):
    emit("failed", reason=reason)
    print(reason, file=sys.stderr, flush=True)
    sys.exit(1)


project, root, out = (Path(arg) for arg in sys.argv[1:4])
plan = json.loads(project.read_text(encoding="utf-8"))
print("arcpy prose that is not JSON", flush=True)
for expected in plan.get("expects", []):
    if not (root / expected).is_file():
        fail(f"missing {expected}")
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
emit("warning", text="These top-level groups are switched off and will NOT be tiled: 背景")
for step, label in enumerate(("Map metadata", "Create Vector Tile Package", "Extract Package", "root.json"), start=2):
    emit("step", step=step, of=5, label=label)
vtiles = out / "tiles" / "p12" / f"{project.stem}.vtiles"
(vtiles / "resources" / "styles").mkdir(parents=True)
(vtiles / "resources" / "styles" / "root.json").write_bytes(b'{"sources":{"esri":{"maxzoom":16}}}')
for z in range(15, 22):
    (vtiles / "tile" / str(z) / "0").mkdir(parents=True)
    (vtiles / "tile" / str(z) / "0" / "0.pbf").write_bytes(bytes([z]) * 3)
emit("result", vtiles=str(vtiles), problems=plan.get("problems", []))
