<div align="center">

# SHP → IMDF Converter

### Shapefile to Indoor Mapping Data Format

<p>
A web application that converts Shapefiles into IMDF-compliant GeoJSON archives.<br />
A guided wizard handles detection, mapping, and configuration,<br />
while an interactive map and table view lets you review, validate, and export — all in the browser.
</p>

<p>
  <img src="https://img.shields.io/badge/Backend-FastAPI-0f766e?style=for-the-badge&logo=fastapi&logoColor=ffffff" />
  <img src="https://img.shields.io/badge/Frontend-React_+_TypeScript-3178c6?style=for-the-badge&logo=react&logoColor=ffffff" />
  <img src="https://img.shields.io/badge/Maps-MapLibre_GL_JS-393552?style=for-the-badge&logo=maplibre&logoColor=ffffff" />
</p>

<p>
  <img src="https://img.shields.io/badge/Format-IMDF-0891b2?style=flat-square" />
  <img src="https://img.shields.io/badge/Input-Shapefiles-0369a1?style=flat-square" />
  <img src="https://img.shields.io/badge/Output-GeoJSON_Archive-56949f?style=flat-square" />
  <img src="https://img.shields.io/badge/Target-Apple_Indoor_Maps-907aa9?style=flat-square" />
</p>

</div>

---

## About

Built for indoor mapping professionals who receive per-floor shapefiles from CAD/GIS workflows and need to produce IMDF output for Apple Maps or other indoor mapping platforms. The application runs on a shared Windows PC — colleagues access it via browser URL with no client-side installation.

---

## Workflow

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 1. Upload│ →  │ 2. Wizard│ →  │ 3. Review│ →  │ 4. Export│
│   Files  │    │  Config  │    │ Map+Table│    │  Archive │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

- **Upload** — Drop shapefiles or pick a folder; feature types are auto-detected from filenames. Existing IMDF archives (`.imdf`) or IMDF-schema shapefiles can also be re-opened directly, skipping the wizard.
- **Wizard** — Step-by-step guided configuration for levels, categories, and mappings
- **Review** — Interactive map + table with geometry colored by category and bidirectional selection
- **Export** — Validation, autofix, and download as an IMDF archive, an Open Data Contest 2026 shapefile set, or a styled QGIS project

---

## Key Features

- Auto-detection of IMDF feature types from shapefile filenames
- Configurable unit category code lookup (company-specific codes supported)
- Auto-generation of footprints, buildings, and venue features from unit geometry
- Column-unit footprints carved out of overlapping units; `Floor_Connect` (階層間接続点) import support
- Geometry quality checks, spatial containment validation, and opening placement verification
- Validation results appear as filterable rows alongside normal features
- Keyboard shortcuts for efficient review (`Ctrl+Z`, `Escape`, `Enter`)
- Round-trip: re-open a previously exported IMDF archive or IMDF-schema shapefile set for further review/re-export
- Export as a raw IMDF archive, an **Open Data Contest 2026** (ODC2026) shapefile profile, or a styled QGIS `.qgz` project built from that profile
- Standalone Adobe Illustrator (`.ai`) → georeferenced GeoPackage, shapefiles and QGIS project: draw boxes around each floor plan on the artwork preview (optionally restricted to specific layers), place the floors on OSM or GSI aerial imagery with a shared scale/rotation frame, drag each floor into place, then export in a chosen CRS. Placements (including multi-floor sets) can be saved by name and reapplied to other files of the same building.

---

## Stack

### Backend
![Python](https://img.shields.io/badge/Python_3.11+-3776ab?style=for-the-badge&logo=python&logoColor=ffffff)
![FastAPI](https://img.shields.io/badge/FastAPI-0f766e?style=for-the-badge&logo=fastapi&logoColor=ffffff)
![GeoPandas](https://img.shields.io/badge/GeoPandas-139c5a?style=for-the-badge)
![Shapely](https://img.shields.io/badge/Shapely-475569?style=for-the-badge)

Also uses `fiona`/`pyproj` for shapefile I/O, `pdfminer.six` to parse Illustrator/PDF content streams, and `jsonschema`/`pycountry` for IMDF validation. QGIS project export shells out to a QGIS-bundled Python interpreter (`QGIS_PYTHON`) and is optional — the rest of the app works without QGIS installed.

### Frontend
![React](https://img.shields.io/badge/React_18-61dafb?style=for-the-badge&logo=react&logoColor=111827)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=ffffff)
![MapLibre](https://img.shields.io/badge/MapLibre_GL_JS-393552?style=for-the-badge)
![Vite](https://img.shields.io/badge/Vite-646cff?style=for-the-badge&logo=vite&logoColor=ffffff)

---

## Quickstart

```bash
# Clone
git clone <repo-url> shp2imdf
cd shp2imdf

# Python environment
conda create -n shp2imdf python=3.11 -y
conda activate shp2imdf
pip install -r backend/requirements.txt

# Optional: runtime defaults (also where QGIS_PYTHON is configured, if using QGIS export)
cp .env.example .env

# Frontend dependencies
cd frontend && npm ci && cd ..

# Run backend (terminal 1)
uvicorn backend.main:app --reload

# Run frontend (terminal 2)
cd frontend && npm run dev
```

Open `http://localhost:5173`.

### Shared Windows PC

```bash
copy .env.example .env
cd frontend && npm ci && npm run build && cd ..
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Colleagues can access `http://<pc-hostname>:8000`.

---

## Tests

```bash
python -m pytest backend/tests -v
cd frontend && npm run test && npm run build
```

---

<div align="center">

Shapefiles / IMDF / Illustrator artwork → guided configuration → visual review → IMDF, ODC2026, or QGIS export

</div>
