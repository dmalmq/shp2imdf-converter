# shp2imdf-converter

Convert Shapefiles (`.shp`) into IMDF archives using a
FastAPI backend and a React frontend.

## Quickstart (Development)

```bash
# 1) Clone
git clone <repo-url> shp2imdf
cd shp2imdf

# 2) Python environment
conda create -n shp2imdf python=3.11 -y
conda activate shp2imdf
pip install -r backend/requirements.txt

# Optional: runtime defaults
cp .env.example .env

# 3) Frontend dependencies
cd frontend
npm ci
cd ..

# 4) Run backend (terminal 1)
uvicorn backend.main:app --reload

# 5) Run frontend (terminal 2)
cd frontend
npm run dev
```

Open `http://localhost:5173`.

## Quickstart (Shared Windows PC)

```bash
copy .env.example .env
cd frontend
npm ci
npm run build
cd ..
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Colleagues can access `http://<pc-hostname>:8000`.

## Smoke Test Checklist

```bash
python -m pytest backend/tests/test_api.py -v
python -m pytest backend/tests/test_edge_cases.py -v
cd frontend
npm run test
npm run build
```

Then open `http://localhost:8000` and verify:
- Upload works and shows cleanup summary.
- Wizard blocks `Next` when required fields are missing.
- Review supports keyboard shortcuts (`Ctrl+Z`, `Escape`, `Enter` in export dialog).
- Validation and export complete successfully.

## Documentation

- Setup and operations source of truth: `DEVELOPMENT.md`
- Functional and API specification: `SPEC.md`
