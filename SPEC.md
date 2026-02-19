# SPEC.md — SHP→IMDF Converter

## 1. Project Purpose

A web application that converts Shapefiles into IMDF (Indoor
Mapping Data Format) compliant GeoJSON archives. A Python
(FastAPI) backend handles all geospatial processing while a
React (MapLibre GL JS) frontend provides a guided wizard
for configuration followed by an interactive map view for
visual review, validation, and export.

Target users are indoor mapping professionals who receive
per-floor shapefiles from CAD/GIS workflows and need to
produce IMDF output for Apple Maps or other indoor mapping
platforms.

### Success Criteria

- User can import multiple shapefiles and have feature types
  auto-detected from filenames
- A step-by-step wizard guides the user through all
  configuration before reaching the map view
- Unit category codes are resolved from a configurable JSON
  lookup (company-specific codes supported)
- Footprints, buildings, and venue features are auto-generated
  from unit geometry
- Interactive map + table view shows geometry colored by
  category with bidirectional selection for visual review
- Validation catches geometry quality issues, spatial
  containment problems, opening placement errors, and IMDF
  property requirements — not just structural checks
- Validation results appear as filterable rows in the table
  alongside normal features
- Exported IMDF archive passes schema validation
- The application runs on a shared Windows PC that
  colleagues access via browser URL — no client-side
  installation
- Shared-PC deployment defaults to local-subnet network
  exposure and can be fronted by organizational TLS/auth
  controls when required
- Production profile supports persistent session storage so
  in-progress projects survive service restarts until TTL
  expiry
- Setup is reproducible from committed environment specs and
  lockfiles

### User Workflow

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 1. Upload│ →  │ 2. Wizard│ →  │ 3. Review│ →  │ 4. Export│
│   Files  │    │  Config  │    │  Map+Table│    │   .imdf  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

1. **Upload** — full-page drop zone or folder picker
2. **Wizard** — multi-step guided configuration
3. **Review** — map + table for visual confirmation,
   validation, and corrections
4. **Export** — confirmation screen and download

---

## 2. IMDF Feature Hierarchy

IMDF defines a strict hierarchy of feature types. The converter
must produce valid GeoJSON for each:

```
Address (1+, unlocated)
Venue (1)
└── Building (1+, unlocated)
    └── Footprint (1+ per building)
        └── Level (1+ per building)
            ├── Unit (1+ per level)
            ├── Opening (0+ per level)
            ├── Fixture (0+ per level)
            └── Detail (0+ per level)
```

### Feature Types & Property Structures

Every IMDF feature MUST have:

- `id` — UUID string
- `type` — always "Feature"
- `feature_type` — matches the file name (e.g., "unit")
- `geometry` — GeoJSON geometry or null for unlocated
- `properties` — object containing the type-specific keys

Name fields use the **LABELS** format — a JSON object with
BCP 47 language tags as keys:

```json
{ "en": "Tokyo Station", "ja": "東京駅" }
```

The wizard's language selector (default "en") sets the
primary language tag. All name fields collected as plain text
are wrapped in the configured language tag on export.

---

#### Address (unlocated)

Geometry: **null**

| Property           | Type               | Required | Description                           |
| ------------------ | ------------------ | -------- | ------------------------------------- |
| address            | STRING             | Yes      | Street address, excluding unit/suite. |
|                    |                    |          | If no street address exists, use the  |
|                    |                    |          | venue or building name.               |
| unit               | STRING or null     | No       | Suite/unit designation                |
| locality           | STRING             | Yes      | City or town                          |
| province           | ISO 3166-2 or null | No\*     | State/province code. Required when    |
|                    |                    |          | defined by ISO for the country.       |
| country            | ISO 3166           | Yes      | Country code                          |
| postal_code        | STRING or null     | No       | Postal/ZIP code                       |
| postal_code_ext    | STRING or null     | No       | Postal code extension                 |
| postal_code_vanity | STRING or null     | No       | Vanity postal code                    |

```json
{
  "id": "addr-uuid",
  "type": "Feature",
  "feature_type": "address",
  "geometry": null,
  "properties": {
    "address": "1-9-1 Marunouchi",
    "unit": null,
    "locality": "Chiyoda-ku",
    "province": "JP-13",
    "country": "JP",
    "postal_code": "100-0005",
    "postal_code_ext": null,
    "postal_code_vanity": null
  }
}
```

---

#### Venue

Geometry: **Polygon**

| Property      | Type                | Required | Description           |
| ------------- | ------------------- | -------- | --------------------- |
| category      | VENUE-CATEGORY      | Yes      | Function of the venue |
| restriction   | RESTRICTION or null | No       | Access restriction    |
| name          | LABELS              | Yes      | Official name         |
| alt_name      | LABELS or null      | No       | Alternative name      |
| hours         | HOURS or null       | No       | Operating hours       |
| phone         | PHONE or null       | No       | Phone number          |
| website       | WEBSITE or null     | No       | Website URL           |
| display_point | DISPLAY-POINT       | Yes      | Label anchor point    |
| address_id    | ADDRESS-ID          | Yes      | Reference to Address  |

```json
{
  "id": "venue-uuid",
  "type": "Feature",
  "feature_type": "venue",
  "geometry": { "type": "Polygon", "coordinates": [...] },
  "properties": {
    "category": "transitstation",
    "restriction": null,
    "name": { "en": "Tokyo Station" },
    "alt_name": { "ja": "東京駅" },
    "hours": "Mo-Su 05:00-24:00",
    "phone": "+81-3-3212-2577",
    "website": "https://www.tokyoinfo.com",
    "display_point": { "type": "Point", "coordinates": [139.7671, 35.6812] },
    "address_id": "addr-uuid"
  }
}
```

---

#### Building (unlocated)

Geometry: **null** — physical extent is represented by
Footprint features.

| Property      | Type                  | Required | Description                 |
| ------------- | --------------------- | -------- | --------------------------- |
| name          | LABELS or null        | No       | Official name               |
| alt_name      | LABELS or null        | No       | Alternative name            |
| category      | BUILDING-CATEGORY     | Yes      | Function of the building    |
| restriction   | RESTRICTION or null   | No       | Access restriction          |
| display_point | DISPLAY-POINT or null | No       | Label anchor point. Must be |
|               |                       |          | within a Footprint of this  |
|               |                       |          | building.                   |
| address_id    | ADDRESS-ID or null    | No       | Reference to Address. Null  |
|               |                       |          | implies the Venue's address |
|               |                       |          | applies.                    |

```json
{
  "id": "bldg-uuid",
  "type": "Feature",
  "feature_type": "building",
  "geometry": null,
  "properties": {
    "name": { "en": "Main Terminal" },
    "alt_name": null,
    "category": "unspecified",
    "restriction": null,
    "display_point": { "type": "Point", "coordinates": [139.7671, 35.6812] },
    "address_id": null
  }
}
```

---

#### Footprint

Geometry: **Polygon** (or MultiPolygon for composite
footprints)

| Property     | Type                   | Required | Description                    |
| ------------ | ---------------------- | -------- | ------------------------------ |
| category     | "ground", "aerial", or | Yes      | Nature of the footprint        |
|              | "subterranean"         |          |                                |
| name         | LABELS or null         | No       | Metadata name (not rendered)   |
| building_ids | Array of BUILDING-ID   | Yes      | Building(s) this footprint     |
|              |                        |          | represents. Must not be empty. |

```json
{
  "id": "fp-uuid",
  "type": "Feature",
  "feature_type": "footprint",
  "geometry": { "type": "Polygon", "coordinates": [...] },
  "properties": {
    "category": "ground",
    "name": null,
    "building_ids": ["bldg-uuid"]
  }
}
```

---

#### Level

Geometry: **Polygon**

| Property      | Type                         | Required | Description                     |
| ------------- | ---------------------------- | -------- | ------------------------------- |
| category      | LEVEL-CATEGORY               | Yes      | Function (e.g., "unspecified",  |
|               |                              |          | "parking", "transit")           |
| restriction   | RESTRICTION or null          | No       | Access restriction              |
| outdoor       | Boolean                      | Yes      | True if physically outside      |
| ordinal       | INTEGER                      | Yes      | Stacking position (0 = ground)  |
| name          | LABELS                       | Yes      | Floor name                      |
| short_name    | LABELS                       | Yes      | Short floor label               |
| display_point | DISPLAY-POINT or null        | No       | Label anchor point              |
| address_id    | ADDRESS-ID or null           | No       | Only if different from          |
|               |                              |          | building/venue address          |
| building_ids  | Array of BUILDING-ID or null | No       | Building(s) this level belongs  |
|               |                              |          | to. Required for indoor levels. |

```json
{
  "id": "level-uuid",
  "type": "Feature",
  "feature_type": "level",
  "geometry": { "type": "Polygon", "coordinates": [...] },
  "properties": {
    "category": "unspecified",
    "restriction": null,
    "outdoor": false,
    "ordinal": 0,
    "name": { "en": "Ground Floor" },
    "short_name": { "en": "GF" },
    "display_point": { "type": "Point", "coordinates": [139.7671, 35.6812] },
    "address_id": null,
    "building_ids": ["bldg-uuid"]
  }
}
```

---

#### Unit

Geometry: **Polygon**

| Property      | Type                   | Required | Description            |
| ------------- | ---------------------- | -------- | ---------------------- |
| category      | UNIT-CATEGORY          | Yes      | Function of the space  |
| restriction   | RESTRICTION or null    | No       | Access restriction     |
| accessibility | Array of ACCESSIBILITY | No       | Accessibility features |
|               | or null                |          |                        |
| name          | LABELS or null         | No       | Unit name              |
| alt_name      | LABELS or null         | No       | Alternative name       |
| level_id      | LEVEL-ID               | Yes      | Reference to Level     |
| display_point | DISPLAY-POINT or null  | No       | Label anchor point     |

```json
{
  "id": "unit-uuid",
  "type": "Feature",
  "feature_type": "unit",
  "geometry": { "type": "Polygon", "coordinates": [...] },
  "properties": {
    "category": "room",
    "restriction": null,
    "accessibility": null,
    "name": { "en": "Main Lobby" },
    "alt_name": null,
    "level_id": "level-uuid",
    "display_point": { "type": "Point", "coordinates": [139.7671, 35.6812] }
  }
}
```

---

#### Opening

Geometry: **LineString**

| Property       | Type                    | Required | Description                 |
| -------------- | ----------------------- | -------- | --------------------------- |
| category       | OPENING-CATEGORY        | Yes      | Type of entrance            |
| accessibility  | Array of ACCESSIBILITY  | No       | Accessibility features      |
|                | or null                 |          |                             |
| access_control | Array of ACCESS-CONTROL | No       | Access control systems      |
|                | or null                 |          |                             |
| door           | DOOR or null            | No       | Physical door description   |
|                |                         |          | (automatic, material, type) |
| name           | LABELS or null          | No       | Opening name                |
| alt_name       | LABELS or null          | No       | Alternative name            |
| display_point  | DISPLAY-POINT or null   | No       | Label anchor point          |
| level_id       | LEVEL-ID                | Yes      | Reference to Level          |

OPENING-CATEGORY values: "automobile", "bicycle",
"pedestrian", "emergencyexit", "pedestrian.principal",
"pedestrian.transit", "service"

DOOR object structure:

```json
{
  "automatic": true,
  "material": "glass",
  "type": "sliding"
}
```

```json
{
  "id": "opening-uuid",
  "type": "Feature",
  "feature_type": "opening",
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [100.0, 0.0],
      [101.0, 1.0]
    ]
  },
  "properties": {
    "category": "pedestrian",
    "accessibility": ["wheelchair", "tactilepaving"],
    "access_control": null,
    "door": { "automatic": true, "material": "glass", "type": "sliding" },
    "name": null,
    "alt_name": null,
    "display_point": null,
    "level_id": "level-uuid"
  }
}
```

---

#### Fixture

Geometry: **Polygon**

| Property      | Type                  | Required | Description         |
| ------------- | --------------------- | -------- | ------------------- |
| category      | FIXTURE-CATEGORY      | Yes      | Type of fixture     |
| name          | LABELS or null        | No       | Fixture name        |
| alt_name      | LABELS or null        | No       | Alternative name    |
| anchor_id     | ANCHOR-ID or null     | No       | Reference to Anchor |
| level_id      | LEVEL-ID              | Yes      | Reference to Level  |
| display_point | DISPLAY-POINT or null | No       | Label anchor point  |

```json
{
  "id": "fixture-uuid",
  "type": "Feature",
  "feature_type": "fixture",
  "geometry": { "type": "Polygon", "coordinates": [...] },
  "properties": {
    "category": "furniture",
    "name": null,
    "alt_name": null,
    "anchor_id": null,
    "level_id": "level-uuid",
    "display_point": null
  }
}
```

---

#### Detail

Geometry: **LineString** (NOT Point — IMDF Details are lineal
features used to model physical objects like curbs, railings,
and edges for cognitive recognition.)

| Property | Type     | Required | Description        |
| -------- | -------- | -------- | ------------------ |
| level_id | LEVEL-ID | Yes      | Reference to Level |

Detail has the minimal property structure of any IMDF
feature — only `level_id`. No name, no category.

```json
{
  "id": "detail-uuid",
  "type": "Feature",
  "feature_type": "detail",
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [100.0, 0.0],
      [101.0, 1.0]
    ]
  },
  "properties": {
    "level_id": "level-uuid"
  }
}
```

---

## 3. Shapefile Import

### Expected Input

Users typically provide shapefiles organized per floor and per
feature type. One .shp file = one floor of one feature type.

Example file set for a station:

```
JRTokyoSta_B1_Space.shp    → Level -1, Units
JRTokyoSta_B1_Opening.shp  → Level -1, Openings
JRTokyoSta_B1_Fixture.shp  → Level -1, Fixtures
JRTokyoSta_B1_Detail.shp   → Level -1, Details
JRTokyoSta_GF_Space.shp    → Level 0, Units
JRTokyoSta_GF_Opening.shp  → Level 0, Openings
JRTokyoSta_1_Space.shp     → Level 1, Units
JRTokyoSta_1_Opening.shp   → Level 1, Openings
JRTokyoSta_2_Space.shp     → Level 2, Units
...
```

Each .shp must be accompanied by its .shx, .dbf, and .prj
files. The frontend accepts multi-file or folder upload via
`react-dropzone` and sends all files to the backend as
multipart/form-data. The backend groups sidecar files
automatically by stem.

### CRS Handling

- Read the source CRS from the .prj file via GeoPandas/Fiona
- Return the detected CRS to the frontend for user
  confirmation in the wizard
- Reproject all geometry to WGS84 (EPSG:4326) for IMDF
- Warn if no .prj file is found — wizard prompts user to
  specify CRS manually
- Run Shapely `.make_valid()` on all geometry after
  reprojection

### Import-Time Geometry Cleanup

In addition to `make_valid()`, the importer performs several
geometry cleanup steps immediately on import to prevent
issues from propagating into later stages:

- **MultiPolygon explosion:** if a feature contains a
  MultiPolygon, explode it into separate features, each
  receiving a new UUID. This is common when CAD exports
  combine disconnected rooms under one ID.
- **Ring closure:** if a polygon ring is not closed (first
  coordinate != last coordinate), append the first
  coordinate to close it.
- **Winding order:** normalize exterior rings to
  counterclockwise and interior rings to clockwise using
  Shapely `orient()`, as required by the GeoJSON spec.
- **Empty geometry removal:** features with null or empty
  geometry are dropped and logged as warnings.
- **Coordinate precision normalization:** round all
  coordinates to 7 decimal places (~1cm precision),
  which is sufficient for indoor mapping and prevents
  file bloat from 15+ decimal place coordinates.

These cleanup steps run silently. The import response
includes a `cleanup_summary` field reporting how many
features were exploded, closed, reoriented, or dropped.

---

## 4. Auto-Detection

### 4.1 Feature Type Detection from Filename

Parse the filename against a configurable keyword mapping.
Default keywords shipped in `backend/config/filename_keywords.json`:

```json
{
  "feature_type_keywords": {
    "unit": ["space", "unit", "room", "area"],
    "opening": ["opening", "door", "entry", "gate"],
    "fixture": ["fixture", "fxt", "furniture"],
    "detail": ["detail", "edge", "line", "curb"],
    "level": ["floor", "level", "storey"],
    "building": ["building", "bldg", "structure"],
    "venue": ["venue", "site", "campus", "property"]
  }
}
```

Matching is case-insensitive. Check for keyword presence
anywhere in the filename (not just exact match).

Detection confidence levels:

- **Green (confident):** keyword match found
- **Yellow (guess):** inferred from geometry type only
  (polygon → unit, linestring → opening or detail,
  point → no IMDF match, flag for manual classification).
  Note: both Opening and Detail use LineString, so
  geometry alone cannot distinguish them. LineString files
  default to "opening" (more common) with yellow confidence.
- **Red (unknown):** no match — user must label manually

### 4.2 Level Number Detection from Filename

Parse digits and basement indicators from the filename:

| Pattern          | Ordinal | Example              |
| ---------------- | ------- | -------------------- |
| `_1_` or `_1.`   | 1       | Station_1_Space.shp  |
| `_2_` or `_2.`   | 2       | Station_2_Space.shp  |
| `_B1_` or `_-1_` | -1      | Station_B1_Space.shp |
| `_B2_` or `_-2_` | -2      | Station_B2_Space.shp |
| `_GF_` or `_G_`  | 0       | Station_GF_Space.shp |
| `_0_`            | 0       | Station_0_Space.shp  |

If level cannot be detected, the wizard highlights the file
and prompts the user to specify.

### 4.3 Session Learning

If the user relabels a file and the filename contains an
unrecognized keyword, offer to apply that keyword to other
files in the same session. Example: user labels a file
containing "Tila" as unit type → prompt "Apply 'Tila' as
a unit keyword to 3 other files?"

---

## 5. Attribute Mapping

### 5.1 Unit Category Mapping

Unit polygons in shapefiles often have a category/type
attribute column containing company-specific codes. These
must be mapped to IMDF unit categories through a two-file
system:

**Standard categories** are defined in
`backend/config/unit_categories.json`, which ships with
the app and represents the IMDF specification's allowed
category values. This file is not user-editable.

**Company code mappings** are defined in a separate JSON
file that maps company-specific codes to IMDF categories.
A sample ships as `backend/config/company_mappings.json`.
Users upload their own mapping file during the wizard
Unit Mapping step.

Company mappings file format:

```json
{
  "code_column": "CATEGORY",
  "mappings": {
    "B0001": "foodservice",
    "B0002": "retail",
    "B0003": "restroom"
  }
}
```

The `code_column` field tells the mapper which shapefile
attribute column contains the codes. If the column is not
found, the wizard presents the available columns for the
user to select.

**Resolution logic:**

1. Look up the raw code in `company_mappings.mappings`
2. If found, validate the result against
   `unit_categories.valid_categories`
3. If the code is not in the mappings, or the mapped value
   is not a valid IMDF category, resolve to
   `unit_categories.default` ("unspecified")
4. Unspecified features are flagged in the wizard summary
   and highlighted in the review table

If no company mappings file is loaded, the mapper checks
whether the raw shapefile values are already valid IMDF
categories (direct mapping).

### 5.2 General Attribute Mapping

During the wizard, the user maps shapefile columns to IMDF
properties via dropdown selectors per feature type:

**Unit:**

- name → LABELS (display name)
- category → UNIT-CATEGORY (via code mapping or direct)
- alt_name → LABELS (alternative name)
- restriction → RESTRICTION-CATEGORY
- accessibility → Array of ACCESSIBILITY-CATEGORY

**Opening:**

- category → OPENING-CATEGORY (pedestrian, automobile,
  emergencyexit, pedestrian.principal, etc.)
- accessibility → Array of ACCESSIBILITY-CATEGORY
- access_control → Array of ACCESS-CONTROL-CATEGORY
- door → DOOR object (automatic, material, type) — this
  requires mapping up to three columns or manual entry
- name → LABELS

**Fixture:**

- name → LABELS (display name)
- alt_name → LABELS (alternative name)
- category → FIXTURE-CATEGORY

**Detail:**

Detail has no mappable properties beyond level_id (which is
assigned via the Level Mapping wizard step). No attribute
mapping is needed for Detail files.

Unmapped columns are preserved in a `properties.metadata`
field so no original data is lost.

---

## 6. Auto-Generation

### 6.1 Address Generation

When the user saves Project Info in the wizard (Step 1),
the backend creates Address features from the structured
address fields:

- **Venue address:** always created. Uses the venue address
  fields from Project Info. Gets a UUID. The venue feature's
  `address_id` references this UUID.
- **Per-building addresses:** if a building has a different
  address than the venue (entered in the Building Assignment
  step), a separate Address feature is created. Otherwise
  the building's `address_id` is set to null (which implies
  the venue's address applies per IMDF spec).

Address features are unlocated (geometry: null) and appear
in `address.geojson` on export.

### 6.2 Level Geometry

If no explicit level/floor geometry files are provided,
generate level polygons by computing the union of all unit
polygons on that level.

Level properties are populated from the wizard:

- `ordinal` — from Level Mapping step
- `name` — from Level Mapping step, wrapped in LABELS
- `short_name` — from Level Mapping step, wrapped in LABELS
- `category` — default "unspecified"
- `outdoor` — default false (user can edit in review)
- `building_ids` — array containing the building UUID(s)
  from Building Assignment step
- `address_id` — null (inherits from building/venue)
- `display_point` — generated from level polygon

### 6.3 Footprint Generation

For each building, generate a footprint from unit geometry:

| Ordinal | Footprint Category |
| ------- | ------------------ |
| 0       | ground             |
| > 0     | aerial             |
| < 0     | subterranean       |

The ground-level footprint (ordinal = 0) is the primary
building footprint. Compute it as the union of all unit
polygons on the ground level with a small buffer (0.5m)
to close gaps.

If no ordinal-0 level exists, use the level with the
lowest non-negative ordinal.

Footprint properties:

- `category` — ground, aerial, or subterranean (from ordinal)
- `name` — null
- `building_ids` — array containing the building UUID

### 6.4 Building Generation

Generate the Building feature as an **unlocated** record
(geometry: null).

Building properties are populated from the wizard:

- `name` — from Building Assignment step, wrapped in LABELS
- `alt_name` — null (editable in review)
- `category` — from Building Assignment step (default
  "unspecified")
- `restriction` — from Building Assignment step (default null)
- `address_id` — null (venue address applies) or references
  a building-specific address if entered
- `display_point` — generated from the ground-level footprint
  using Shapely `representative_point()`. Must be within a
  footprint that references this building (per IMDF spec).

### 6.5 Venue Generation

Generate the venue polygon as the union of all footprint
polygons (specifically the ground-level footprints) with a
buffer (configurable, default 5m).

Venue properties are populated from the wizard:

- `name` — from Project Info, wrapped in LABELS
- `alt_name` — null (editable in review)
- `category` — from Project Info venue category selector
- `restriction` — from Project Info (default null)
- `address_id` — references the venue address
- `display_point` — generated from venue polygon (required)
- `hours`, `phone`, `website` — from Project Info

### 6.6 Unit Property Assembly

Unit features from shapefiles get their IMDF properties
assembled during generation:

- `category` — from attribute mapping / company code
  resolution
- `restriction` — from attribute mapping or null
- `accessibility` — from attribute mapping or null
- `name` — from attribute mapping, wrapped in LABELS
- `alt_name` — from attribute mapping or null
- `level_id` — UUID of the level this unit belongs to (from
  Level Mapping step)
- `display_point` — generated from unit polygon

### 6.7 Opening Property Assembly

Opening features get their IMDF properties assembled:

- `category` — from attribute mapping (required, default
  "pedestrian" if unmapped)
- `accessibility` — from attribute mapping or null
- `access_control` — from attribute mapping or null
- `door` — from attribute mapping or null. If a door column
  exists, the mapper attempts to parse it into the DOOR
  object structure (automatic, material, type).
- `name` — from attribute mapping or null
- `alt_name` — null
- `display_point` — null (openings are lines)
- `level_id` — UUID of the level

### 6.8 Fixture Property Assembly

Fixture features get their IMDF properties assembled:

- `category` — from attribute mapping (required)
- `name` — from attribute mapping or null
- `alt_name` — from attribute mapping or null
- `anchor_id` — null (Anchor features are out of scope for
  this converter)
- `level_id` — UUID of the level
- `display_point` — generated from fixture polygon

### 6.9 Detail Property Assembly

Detail features are the simplest — they only need:

- `level_id` — UUID of the level

No other properties. Original shapefile attributes are
preserved in a `metadata` field for reference but are not
exported in the IMDF output.

### 6.10 Display Point Generation

Generate display points for polygon features using Shapely
`representative_point()`:

- **Venue** — from venue polygon (required by IMDF)
- **Building** — from ground-level footprint polygon.
  Must be within a footprint referencing this building.
- **Level** — from level polygon
- **Unit** — from unit polygon
- **Fixture** — from fixture polygon

Note: Footprint does not have a display_point property per
the IMDF spec. Detail has no display_point property. Opening
display_point is left null (line features).

### 6.11 Footprint Method Options

During the wizard Footprint Options step, offer a choice:

- **Union + buffer** (default) — tighter, more accurate
- **Convex hull** — simpler, may include empty space
- **Concave hull (alpha shape)** — good for complex shapes

Show a small preview thumbnail of each option so the user
can compare before confirming.

---

## 7. User Interface

### 7.1 Application Flow

The application has three distinct screens, navigated
sequentially:

```
┌─────────────────────────────────────────────────┐
│                 1. UPLOAD SCREEN                 │
│                                                 │
│    ┌─────────────────────────────────────┐      │
│    │                                     │      │
│    │     Drag & drop shapefiles here     │      │
│    │     or click to browse / select     │      │
│    │     folder                          │      │
│    │        (react-dropzone)             │      │
│    │                                     │      │
│    └─────────────────────────────────────┘      │
│                                                 │
│    Uploading: ████████████░░░░ 75%              │
│    ✓ StationName_GF_Space.shp (10 features)    │
│    ✓ StationName_GF_Opening.shp (3 features)   │
│    ⟳ StationName_1_Space.shp (uploading...)    │
│                                                 │
│    Cleanup: 2 MultiPolygons exploded, 1 ring    │
│    closed, 0 empty features dropped             │
│                                                 │
│                          [Continue →]           │
└─────────────────────────────────────────────────┘

              ↓ after upload completes

┌─────────────────────────────────────────────────┐
│              2. CONFIGURATION WIZARD             │
│                                                 │
│  ● Project Info          [Skip to Summary →]    │
│  ○ File Classification                          │
│  ○ Level Mapping                                │
│  ○ Building Assignment                          │
│  ○ Unit Mapping                                 │
│  ○ Opening Mapping                              │
│  ○ Fixture Mapping                              │
│  ○ Detail Mapping                               │
│  ○ Footprint Options                            │
│  ○ Summary                                      │
│                                                 │
│  ┌───────────────────────────────────────┐      │
│  │         Current step content          │      │
│  │                                       │      │
│  └───────────────────────────────────────┘      │
│                                                 │
│  Saved ✓          [← Back]       [Next →]       │
└─────────────────────────────────────────────────┘

              ↓ after wizard confirm

┌─────────────────────────────────────────────────┐
│              3. REVIEW & EXPORT                  │
│  [← Wizard]  [Project: ___]  [Validate] [Export]│
├──────────────────────┬──────────────────────────┤
│                      │  Filter: [All ▾] [Lvl ▾] │
│    MapLibre GL JS    │  Status: [All ▾]          │
│                      │  Search: [____________]   │
│  ┌────────┐          ├──────────────────────────┤
│  │ Layers │          │                          │
│  │ ☑ Unit │          │    TanStack Table        │
│  │ ☑ Open │          │    (features + issues)   │
│  │ ☑ Fxtr │          │                          │
│  │ ☑ Detl │          ├──────────────────────────┤
│  └────────┘          │  Properties Panel        │
│                      │  ⚠ Missing category      │
│                      │  Category: [________▾]   │
│                      │  Level: [__▾] Name: ___  │
├──────────────────────┴──────────────────────────┤
│ Validation: 3 errors · 5 warnings · 40 passed   │
│                        [Auto-fix all safe issues]│
└─────────────────────────────────────────────────┘
```

### 7.2 Upload Screen

Full-page upload screen shown on application launch. Built
with `react-dropzone` for reliable drag-and-drop and folder
upload support.

**Drop zone:**

- Large central area accepting drag-and-drop or click
  to browse
- Accepts individual files or entire folders
- All files sent to `POST /api/import` as
  multipart/form-data

**Upload progress:**

- Per-file progress indicators as files upload
- After upload, backend returns detection results:
  filename, feature count, geometry type, detected CRS
- Files listed with checkmarks as they complete
- If CRS is missing for any file, show a warning with
  a CRS selector dropdown inline
- **Cleanup summary** shown below the file list:
  count of MultiPolygons exploded, rings closed, features
  reoriented, empty features dropped. Gives the user
  immediate visibility into data quality before they
  enter the wizard.

**Continue button** becomes active once all files are
uploaded and processed. Navigates to the wizard.

### 7.3 Configuration Wizard

Full-page multi-step wizard. Left sidebar shows all steps
with progress indicators (completed, current, upcoming).
Center area shows the current step's content. Bottom bar
has Back and Next buttons. Steps can be revisited by
clicking the sidebar.

**Skip to Summary:** A "Skip to Summary" link in the
sidebar allows experienced users to jump directly to the
Summary step with all auto-detected values accepted. The
summary highlights any issues (unresolved categories,
missing levels) as warnings so the user can jump back to
specific steps to fix them.

**Auto-save indicator:** A subtle "Saved ✓" indicator
near the navigation buttons confirms that each PATCH to
the backend succeeded. This reassures users that wizard
state persists if they close the browser.

Steps that are not relevant (e.g., Fixture Mapping when
no fixtures were detected) are shown as "Skipped — no
files detected" and can be jumped over, but remain
accessible if the user wants to manually assign files.

#### Step 1: Project Info

- Project name (text input)
- Venue name (text input, required)
- Venue category (dropdown of IMDF venue categories,
  required — e.g., "shoppingcenter", "transitstation",
  "airport", "conventioncenter")
- Language selector (default "en" — sets the LABELS
  language tag for all name fields)

**Venue Address** (structured, required):

- Street address (text input, required — if no street
  address exists, use venue name)
- Unit/suite (text input, optional)
- Locality / city (text input, required)
- Province / state (text input, ISO 3166-2 format —
  required when defined by ISO for the country)
- Country (dropdown, ISO 3166 code, required)
- Postal code (text input, optional)
- Postal code extension (text input, optional)

**Additional venue properties** (optional):

- Venue hours (text input, IMDF hours format e.g.
  "Mo-Fr 08:30-20:00")
- Venue phone (text input, international format)
- Venue website (text input, URL)
- Venue restriction (dropdown: null, "employeesonly",
  "restricted")

This information populates the venue feature, the venue's
Address feature, and manifest.json on export. The wizard
prevents proceeding past this step without venue name,
venue category, and the required address fields (street
address, locality, country), since all are required by
IMDF and would be caught as errors in validation.

When the user saves this step, the backend creates the
venue Address feature and stores it in the session.

#### Step 2: File Classification

Table of all imported files with auto-detection results:

| Column            | Type               | Notes                    |
| ----------------- | ------------------ | ------------------------ |
| Filename          | Text (read-only)   |                          |
| Geometry Type     | Text (read-only)   | Polygon/LineString/Point |
| Feature Count     | Number (read-only) |                          |
| IMDF Feature Type | Dropdown (edit)    | unit/opening/fixture/    |
|                   |                    | detail/level/building/   |
|                   |                    | venue                    |
| Confidence        | Icon (read-only)   | Green/Yellow/Red dot     |

Auto-detected values are pre-filled. User corrects any
red or yellow entries. Session learning prompt appears
when a user relabels a file containing an unrecognized
keyword.

A "Detect All" button re-runs detection with any learned
keywords.

**Preview map** on the right side of this step shows all
geometries colored by detected type. The preview map is
interactive: hovering over a table row zooms the map to
that file's geometry and highlights it. Selecting a row
isolates that file's geometry on the map. This gives
instant visual feedback on what each file contains,
making it easy to classify ambiguous files like
"ShinjukuTerminal_0_Drawing.shp".

#### Step 3: Level Mapping

Table of all files classified in the previous step,
grouped or sorted by detected level:

| Column         | Type             | Notes                    |
| -------------- | ---------------- | ------------------------ |
| Filename       | Text (read-only) |                          |
| Feature Type   | Text (read-only) | From classification      |
| Detected Level | Number (edit)    | Pre-filled from filename |
| Level Name     | Text (edit)      | e.g. "Ground Floor"      |
| Short Name     | Text (edit)      | e.g. "GF" — required     |
| Outdoor        | Checkbox (edit)  | Default false            |
| Category       | Dropdown (edit)  | Default "unspecified"    |

Auto-detected level ordinals are pre-filled. Both level
name and short name are required by IMDF and stored in
LABELS format. The outdoor flag defaults to false. Level
category defaults to "unspecified" but can be set to
"parking" or "transit" where appropriate.

**Stacking diagram** on the right side shows a vertical
stack of colored bars, one per level, ordered by ordinal
from bottom (most negative) to top (most positive). As
the user edits ordinals in the table, the diagram
reorders in real time. The diagram visually flags common
mistakes: two files assigned to the same level ordinal
are highlighted in red, gaps in the ordinal sequence show
a dashed placeholder bar. Each bar shows the level name
and the count of files assigned to it.

#### Step 4: Building Assignment

If the project has multiple buildings, this step lets the
user assign files to buildings:

- Default: all files belong to one building (auto-created)
- User can add buildings and drag/assign files to each
- Per-building fields:
  - Building name (text input, optional — if the venue
    and building are the same physical structure, the
    building name can be null and it inherits the venue
    name per IMDF spec)
  - Building category (dropdown of IMDF building
    categories: "unspecified", "parking", "transit", etc.)
  - Building restriction (dropdown: null, "employeesonly",
    "restricted")
  - **Building address** — a toggle: "Same as venue"
    (default, address_id will be null) or "Different
    address" which reveals the same structured address
    form as Step 1. When a building has a different
    address, a separate Address feature is created.

For single-building projects this step shows the default
assignment (same address as venue) and can be quickly
confirmed.

#### Step 5: Unit Mapping

Configures how unit shapefile attributes map to IMDF
properties:

- **Code column selector:** dropdown of available columns
  from unit shapefiles, pre-selected if "CATEGORY" column
  exists
- **Company mappings upload:** button to upload a custom
  `company_mappings.json` file
- **Mapping preview table:** shows a sample of raw codes
  and their resolved IMDF categories. Displays all unique
  codes found across all unit files (minimum 10-15 rows
  if available), with unresolved codes highlighted in
  yellow. This is the primary mechanism for users to
  verify their company mappings are correct — if the
  wrong mappings file was uploaded, the errors are
  immediately visible here.
- **Column mapping:** dropdowns mapping shapefile columns
  to IMDF properties (name, alt_name, restriction,
  accessibility)

#### Step 6: Opening Mapping

- **Category mapping:** dropdown to map a shapefile column
  to OPENING-CATEGORY. If no column is suitable, all
  openings default to "pedestrian". Available categories:
  automobile, bicycle, pedestrian, emergencyexit,
  pedestrian.principal, pedestrian.transit, service.
- **Accessibility mapping:** column → array of
  ACCESSIBILITY-CATEGORY values
- **Access control mapping:** column → array of
  ACCESS-CONTROL-CATEGORY values (e.g., badgereader)
- **Door mapping:** optionally map columns for door
  automatic (boolean), material (string), and type (string)
  to populate the DOOR object on each opening
- **Name mapping:** column → LABELS
- Preview of detected openings per level

**Category requirement note:** IMDF requires a category
on each opening. If no category column is mapped, all
openings default to "pedestrian".

Only shown if opening files were classified in Step 2.

#### Step 7: Fixture Mapping

- Column mapping for fixture attributes (name, alt_name,
  category)
- Preview of detected fixtures per level

Only shown if fixture files were classified in Step 2.

#### Step 8: Detail Mapping

Detail features in IMDF have no configurable properties
beyond `level_id`, which is already assigned in the Level
Mapping step. This step shows a confirmation:

"Detail files detected: N files with M features. Details
will be exported with their geometry and level assignment.
No attribute mapping is needed."

The user can review which files are classified as details
and reassign any that were incorrectly classified. A small
preview map shows detail geometry (LineStrings) on their
assigned levels.

Only shown if detail files were classified in Step 2.

#### Step 9: Footprint Options

- Footprint generation method selector with visual
  preview thumbnails:
  - Union + buffer (default)
  - Convex hull
  - Concave hull (alpha shape)
- Buffer distance slider (default 0.5m for footprint,
  5m for venue)
- Small preview map showing the generated footprint
  overlaid on unit geometry

#### Step 10: Summary

Read-only summary of all configuration:

- Project name and venue info (with alert if required
  address fields are missing)
- Venue category
- Address summary: venue address formatted as a single
  line, plus count of building-specific addresses if any
  differ from the venue address
- File count by feature type
- Level count and ordinal range (with alert if gaps exist)
- Building count, with names and categories
- Category mapping coverage (X of Y codes mapped,
  Z unspecified)
- Opening category coverage (mapped or defaulting to
  "pedestrian")
- Footprint method selected
- Language tag for all LABELS fields
- Import cleanup summary (how many features were fixed
  during import)
- Any warnings highlighted in yellow with links back to
  the relevant wizard step

Two buttons:

- **← Back** — return to wizard to adjust
- **Confirm & Open Review →** — sends
  `POST /api/session/{id}/generate` to trigger
  auto-generation of addresses, footprints, buildings
  (unlocated), venue, level geometry, and display points,
  then navigates to the review screen

### 7.4 Review Screen

The main editing view shown after the wizard is confirmed.
Two-panel layout: interactive map left (~60%), data table
and properties panel right (~40%). Thin toolbar at top.
Validation summary bar at bottom (visible after validation).

#### Toolbar

- **← Back to Wizard** — returns to wizard for
  reconfiguration (confirmation dialog warns that manual
  edits made in the review screen will be lost if the
  wizard regenerates features)
- **Project name** display
- **Validate** button — runs validation, merges results
  into the table
- **Export .imdf** button — opens export confirmation
  screen

#### Map Panel (Left)

Interactive map canvas rendered with MapLibre GL JS
(v4+) using the `react-map-gl/maplibre` wrapper. Wrapped
in a React error boundary to gracefully handle WebGL
context loss or bad GeoJSON.

**Layers & Rendering:**

- GeoJSON sources per feature type from the API
- MapLibre `<Layer>` with data-driven category colors
  via `match` expression
- Venue: dashed outline via `line-dasharray`
- Footprints: semi-transparent fill layer
- Units: solid fill colored by category
- Openings: colored line layer by category
- Fixtures: hatched fill using `fill-pattern`
- Details: colored line layer (thinner than openings,
  distinguished by style — Details are LineStrings
  like Openings but represent physical edges rather
  than entrances)
- **Note:** Building and Address features are unlocated
  (geometry: null) and do not appear on the map. They
  are visible only in the table.
- **Validation overlays:** features with errors get a
  red outline overlay layer, warnings get yellow. These
  layers use filter expressions matching issue feature
  IDs from the validation results in the Zustand store.
- **Overlap visualization:** when validation detects
  overlapping units, the overlapping region is rendered
  as a hatched red fill on its own layer, making the
  problem area immediately visible.

**Layer tree** (collapsible left edge):

- Checkbox per feature type for visibility (only located
  types: venue, footprint, level, unit, opening, fixture,
  detail)
- Level filter / floor selector
- Opacity slider per type group
- After validation: toggles for error/warning highlight
  overlays and overlap visualization layer

**Interactions:**

- Click → select feature, highlight in table, show
  properties
- Hover → tooltip with name, type, category
- Zoom to fit on initial load via `fitBounds`
- Pan/zoom persists across interactions (React state)
- Lasso/box select for multi-feature selection
- Click validation issue → flies to offending feature

**Base map:** OpenStreetMap or vector tiles, toggleable
to satellite or blank.

#### Table Panel (Right)

TanStack Table showing all features including unlocated
features (Address, Building). After validation, issues
are reflected as status values on existing feature rows.

**Filter bar:**

- Feature type filter: all / address / venue / building /
  footprint / level / unit / opening / fixture / detail
- Level filter: dropdown of levels
- Category filter: dropdown of categories
- **Status filter:** all / mapped / unspecified / error /
  warning
- Search box: filters by name or attribute

All filters are applied client-side on cached GeoJSON.
No API round-trip for filtering.

**Table columns:**

| Column       | Type             | Notes                          |
| ------------ | ---------------- | ------------------------------ |
| ID           | Text (read-only) | UUID                           |
| Name         | Text (edit)      | LABELS format in output        |
| Feature Type | Text (read-only) |                                |
| Category     | Dropdown (edit)  | Type-specific options.         |
|              |                  | Not shown for Detail.          |
| Level        | Dropdown (edit)  | Level reference                |
| Building     | Dropdown (edit)  | Building ref (for levels/      |
|              |                  | footprints)                    |
| Status       | Badge            | ✓ mapped / ⚠ warning / ✕ error |

The table adapts its visible columns based on the feature
type filter. When filtered to a specific type,
type-relevant columns appear:

- **Unit:** + restriction, accessibility
- **Opening:** + accessibility, access_control
- **Fixture:** + anchor_id (read-only, null)
- **Level:** + ordinal, short_name, outdoor, building_ids
- **Footprint:** + building_ids
- **Building:** + restriction, address_id (unlocated)
- **Address:** + all address fields (unlocated)
- **Detail:** minimal — only ID, level, status

When a feature has multiple validation issues (e.g., a
unit that has both an unspecified category and overlaps
with an adjacent unit), the status shows the most severe
issue and the properties panel lists all issues.

Row click updates Zustand `selectedFeatureIds`, which
triggers MapLibre highlight and camera fly-to (for located
features). Multi-row selection via shift-click or checkbox
for bulk operations.

**Bulk actions** (when multiple rows selected):

- Reassign to different level
- Change category
- Delete (with confirmation)
- Merge adjacent polygons (units only)

#### Properties Panel

Below the table, collapsible Shadcn Accordion for the
selected feature:

- **Validation issue banner:** if the feature has
  validation errors or warnings, a prominent colored
  banner appears at the top of the properties panel.
  Red for errors, yellow for warnings. Each issue is
  listed with a clear description and points to the fix.
  Examples:
  - "Missing category — select a category from the
    dropdown below."
  - "Overlaps with unit 'Room 203' — adjust boundary
    or delete one of the overlapping features."
  - "Opening not touching any unit boundary — reposition
    the opening or check level assignment."
  - "Coordinates at null island (0,0) — likely CRS error,
    return to wizard and check CRS setting."
    Where an auto-fix is available, a button appears inline:
    "Auto-fix: clean up sliver geometry" or "Auto-fix:
    assign to nearest level."
- All IMDF properties with inline editing
- Source shapefile attributes (read-only, collapsible)
- Attribute mapping dropdowns
- Relationship references as dropdowns (level_id,
  building_ids, address_id)
- Diff highlight for changed properties

Property edits send `PATCH /api/session/{id}/features/{fid}`
to the backend.

**Undo:** The last several property edits are tracked in
the Zustand store as a stack of previous values. Ctrl+Z
(or Cmd+Z on Mac) reverts the most recent edit by sending
the previous value back as a PATCH. This covers the common
case of accidentally changing the wrong field while fixing
validation issues. See Section 10.3 for full undo/redo
as a future enhancement.

#### Validation Flow

When the user clicks **Validate**:

1. Frontend sends `POST /api/session/{id}/validate`
2. Backend runs all checks (see Section 9 for the full
   list), returns structured results with per-feature
   errors and warnings
3. Frontend merges validation results into the feature
   data — each feature gets a `status` field updated to
   "error", "warning", or "passed", and an `issues` array
   with detailed descriptions
4. **Table automatically filters to Status = "error"**
   so the user immediately sees problems. The status
   filter switches to "error" and the table sorts errors
   to the top.
5. Map overlay layers activate, showing red outlines on
   error features, yellow on warnings, and hatched red
   fills on overlap regions
6. User fixes issues by editing in the table or
   properties panel (guided by the validation issue
   banner)
7. User clicks **Validate** again to re-check
8. If no errors remain after re-validation, the status
   filter switches to "warning" to show remaining
   warnings
9. If no warnings either, a success banner appears:
   "All checks passed — ready to export"
10. **Export** button becomes fully enabled

**Validation summary bar** appears at the bottom of the
screen after validation:

```
Validation: 3 errors · 5 warnings · 40 passed
[Auto-fix all safe issues (7 fixable)]
```

The "Auto-fix all" button sends
`POST /api/session/{id}/autofix`, applies all safe fixes,
and re-runs validation automatically. The count in
parentheses shows how many issues have auto-fix available.

#### Export Flow

When the user clicks **Export**:

1. If unresolved errors exist, the button shows
   "Export with errors" and is disabled — user must fix
   or acknowledge
2. If only warnings exist (no errors), the button opens
   an **export confirmation screen** — a modal or
   full-page overlay showing:
   - Feature count summary: "Exporting 48 features
     (24 units, 8 openings, 3 levels, ...)"
   - Warning summary: "2 warnings remain — these should
     be reviewed in Apple IMDF Sandbox"
   - Warning list with descriptions
   - **Download .imdf** button that triggers
     `GET /api/session/{id}/export`
   - **Cancel** button to return to the review screen
3. If no errors or warnings, the confirmation screen
   shows a clean summary and the download button
4. Backend returns the .imdf ZIP as a downloadable blob

This prevents accidental exports and gives the user a
final mental checkpoint before downloading.

### 7.5 Map Rendering Specifications

- MapLibre GL JS v4+ with `react-map-gl/maplibre` wrapper
- WebGL vector rendering — no server-side rasterization
- Color scheme per IMDF category using MapLibre `match`
  expressions
- Selection highlight via MapLibre filter expression
  matching selected IDs in Zustand store
- Validation error/warning overlays as additional MapLibre
  layers with filter expressions matching issue feature IDs
- Overlap visualization layer showing hatched red fill on
  detected overlap regions
- Coordinate display on hover (lat/lng)
- React error boundary wrapping the map component to
  gracefully handle WebGL context loss

---

## 8. IMDF Output Format

The exported .imdf file is a ZIP archive containing:

```
output.imdf
├── manifest.json
├── address.geojson
├── venue.geojson
├── building.geojson
├── footprint.geojson
├── level.geojson
├── unit.geojson
├── opening.geojson     (if openings exist)
├── fixture.geojson     (if fixtures exist)
└── detail.geojson      (if details exist)
```

### manifest.json

```json
{
  "version": "1.0.0",
  "created": "2026-02-13T00:00:00Z",
  "language": "en"
}
```

Each GeoJSON file is a FeatureCollection with features
conforming to the IMDF specification. See Section 2 for
the complete property structure and example of each feature
type.

Every feature must have:

- A unique UUID `id` property (string format)
- A `feature_type` member matching the file name
- A `geometry` member (null for Address and Building,
  Polygon for Venue/Footprint/Level/Unit/Fixture,
  LineString for Opening/Detail)
- A `properties` member with all required IMDF properties
- Name fields in LABELS format (language-tagged objects)
- `display_point` within the feature geometry where
  applicable (required for Venue; recommended for Building,
  Level, Unit, Fixture)
- Referential IDs (address_id, level_id, building_ids)
  pointing to valid existing features

---

## 9. Validation

Before export, validate the full output against the IMDF
specification. Results are returned as structured JSON and
merged into the feature table as status badges.

Validation is organized into three tiers: errors that must
be fixed before export, warnings that should be reviewed,
and auto-fixable issues that can be resolved with one click.

### 9.1 Required Checks (Errors)

These block export. The user must fix or auto-fix all errors
before downloading the .imdf archive.

**Structural & Hierarchy:**

- All features have unique UUID ids (string format)
- Every feature has a feature_type member matching its file
- Venue exists with required properties
- At least one building exists
- Each building has at least one footprint
- Each building has at least one level
- Each output file is a valid GeoJSON FeatureCollection
  with `type` and `features` fields

**Address & Reference Integrity:**

- At least one Address feature exists
- Each Address has required properties: address, locality,
  country
- Address province field is present when ISO 3166-2 defines
  subdivisions for the country
- Venue has an address_id referencing a valid Address feature
- Building address_id, when not null, references a valid
  Address feature
- All other referential IDs (level_id, building_ids) point
  to existing features
- No orphaned Address features (every Address is referenced
  by at least one Venue or Building)

**Geometry Type:**

- Opening geometry is LineString (not Polygon)
- Detail geometry is LineString (not Point or Polygon)
- Unit geometry is Polygon (not MultiPolygon)
- Fixture geometry is Polygon
- Venue geometry is Polygon
- Footprint geometry is Polygon (or MultiPolygon for
  composite footprints)
- Level geometry is Polygon
- Building geometry is null
- Address geometry is null

**Geometry Validity:**

- All geometry is valid (passes Shapely `is_valid`)
- No empty or null geometry on located features
- No coordinates outside WGS84 bounds (longitude -180 to
  180, latitude -90 to 90)
- No features at null island (0,0) unless the venue is
  actually located in the Gulf of Guinea — detected by
  checking if any feature centroid is within 1 degree of
  (0,0) while the venue centroid is elsewhere
- Polygon rings are closed (first coordinate equals last)

**IMDF Property Requirements:**

- Each level has an ordinal (integer)
- Each level has a name and short_name (both LABELS format)
- Each level has an outdoor property (boolean)
- Each level has building_ids referencing valid buildings
  (for indoor levels)
- Each unit has a category
- Each unit has a level_id referencing a valid level
- Each opening has a category
- Each opening has a level_id referencing a valid level
- Each fixture has a category
- Each fixture has a level_id referencing a valid level
- Each detail has a level_id referencing a valid level
- Each footprint has a category (ground/aerial/subterranean)
- Each footprint has building_ids referencing valid buildings
- Venue has a display_point within its polygon (required)
- Venue has an address_id referencing a valid address
- Building display_point, when present, is within a
  footprint that references that building

**LABELS & Feature Structure:**

- All name fields are LABELS objects (language-tagged),
  not plain strings
- LABELS objects have at least one key that is a valid
  BCP 47 language tag
- Display points, when present, are within their parent
  feature geometry

### 9.2 Warning Checks

These do not block export but should be reviewed. Many
indicate data quality issues that Apple's IMDF Sandbox
will also flag.

**Category & Property Warnings:**

- Units with "unspecified" category
- Openings with "pedestrian" default when a more specific
  category may be appropriate
- Openings with missing door property (recommended for
  pedestrian entrances)
- Openings using "pedestrian" category when
  "pedestrian.principal" may be more appropriate (i.e.,
  openings on the venue boundary)
- Missing optional properties (name, alt_name)

**Address Warnings:**

- Address field contains venue/building name instead of
  street address (valid per IMDF but worth flagging)
- Postal code is missing (not required but recommended)
- Multiple buildings reference the same Address when they
  have physically different locations

**Display Point Warnings:**

- Building display_point is missing (recommended)
- Unit display_point is missing (recommended for named
  units)
- Level display_point is missing (recommended)

**Geometry Quality Warnings:**

- Overlapping units on the same level — detected by
  checking pairwise intersection area between all unit
  polygons on each level. Two units with intersection
  area greater than 0.1 sq meters are flagged. The
  overlap region geometry is returned in the validation
  response for map visualization.
- Near-degenerate polygons (slivers) — detected by
  checking area-to-perimeter ratio. A polygon with
  area < 0.1 sq meters or with area/perimeter² ratio
  below 0.01 is flagged.
- Duplicate geometry — detected by comparing WKB hashes
  of all features on the same level. Two features with
  identical geometry but different IDs are flagged.
- Very small geometries (area < 0.5 sq meters for units)
  that may be CAD artifacts
- Very large geometries (area > 100,000 sq meters for
  units) that may indicate a CRS issue
- Flipped lat/lng coordinates — detected by heuristic:
  if a feature's longitude is in the -90 to 90 range and
  its latitude is outside that range, coordinates are
  likely swapped
- Excessive coordinate precision (> 7 decimal places on
  any coordinate) — should have been normalized on import
  but validates as a safety net

**Spatial Containment Warnings:**

- Units spatially outside their assigned level polygon —
  detected by checking if the unit centroid falls within
  the level polygon. Units entirely outside are flagged
  with a different severity than units partially outside.
- Levels spatially outside their building's footprints
- Footprints spatially outside the venue polygon

**Opening-Specific Warnings:**

- Openings not touching any unit boundary on their level
  — detected by buffering all unit polygon boundaries on
  the same level by 0.5m and checking if the opening
  LineString intersects the buffered boundaries. A small
  buffer tolerance accounts for snapping imprecision.
- Openings crossing unit interiors — detected by checking
  if the opening midpoint falls inside a unit polygon
  rather than on or near its boundary
- Openings with unusual length: shorter than 0.3m (likely
  a CAD artifact) or longer than 10m (likely a wall, not
  a door)

**Detail-Specific Warnings:**

- Detail LineString is degenerate (zero length)
- Detail is not within its assigned level polygon

**Cross-Level Consistency Warnings:**

- Level ordinal gaps — non-contiguous ordinal sequence
  (e.g., -1, 0, 3 with 1 and 2 missing)
- Large unit count disparity between levels on the same
  building — if one level has more than 5x the units of
  another level, flag as a potential data issue
- Levels with no units assigned
- Buildings with only one level

### 9.3 Auto-fixable Issues

The following issues can be resolved automatically via
`POST /api/session/{id}/autofix`. Each auto-fix is safe
and deterministic — it will not make destructive changes
or lose data. The auto-fix response reports exactly what
was changed.

**Geometry Fixes:**

- Invalid geometry → Shapely `make_valid()`
- Near-degenerate slivers → `buffer(0.01).buffer(-0.01)`
  to clean spikes and remove slivers
- Unclosed polygon rings → append first coordinate
- Wrong winding order → Shapely `orient()`
- Excessive coordinate precision → round to 7 decimal
  places
- MultiPolygon units → explode into individual features
  with new UUIDs (safety net — normally handled on import)

**Reference Fixes:**

- Orphaned units (no valid level_id) → assign to nearest
  level by centroid distance
- Missing opening level_id → infer from the source file's
  level assignment in the wizard
- Missing detail level_id → infer from source file
- Duplicate UUIDs → regenerate with new UUIDs
- Footprints outside venue → regenerate venue polygon to
  encompass all footprints

**Coordinate Fixes:**

- Flipped lat/lng coordinates → swap all coordinates on
  the affected features

**Prompted Fixes (require user confirmation):**

These are offered as auto-fix but require the user to
confirm before applying, since they involve data deletion:

- Duplicate geometry → delete the duplicate feature (user
  chooses which to keep)
- Empty geometry features → delete the feature
- Units entirely outside their level → reassign to the
  nearest level or delete

### 9.4 Validation Response Shape

```json
{
  "errors": [
    {
      "feature_id": "uuid-here",
      "check": "missing_category",
      "message": "Unit has no category assigned",
      "severity": "error",
      "auto_fixable": false,
      "fix_description": null
    },
    {
      "feature_id": "uuid-here",
      "check": "invalid_geometry",
      "message": "Polygon has self-intersection at ...",
      "severity": "error",
      "auto_fixable": true,
      "fix_description": "Run make_valid() to repair"
    }
  ],
  "warnings": [
    {
      "feature_id": "uuid-1",
      "related_feature_id": "uuid-2",
      "check": "overlapping_units",
      "message": "Overlaps with 'Room 203' (2.3 sq m)",
      "severity": "warning",
      "auto_fixable": false,
      "fix_description": null,
      "overlap_geometry": { "type": "Polygon", "coordinates": [...] }
    },
    {
      "feature_id": "uuid-here",
      "check": "opening_not_touching_boundary",
      "message": "Opening does not touch any unit boundary on Level 0",
      "severity": "warning",
      "auto_fixable": false,
      "fix_description": null
    },
    {
      "feature_id": null,
      "check": "level_ordinal_gap",
      "message": "Level ordinals have gap: -1, 0, 3 (missing 1, 2)",
      "severity": "warning",
      "auto_fixable": false,
      "fix_description": null
    }
  ],
  "passed": [
    "unique_uuids",
    "valid_geometry",
    "venue_exists",
    "venue_has_address",
    "address_exists",
    "address_references_valid",
    "buildings_exist",
    "footprints_exist",
    "levels_have_ordinals",
    "levels_have_short_names",
    "levels_have_outdoor",
    "levels_have_building_ids",
    "units_have_categories",
    "units_have_level_ids",
    "openings_have_categories",
    "openings_have_level_ids",
    "fixtures_have_categories",
    "fixtures_have_level_ids",
    "details_have_level_ids",
    "footprints_have_categories",
    "footprints_have_building_ids",
    "geometry_types_correct",
    "coordinates_in_bounds",
    "no_null_island",
    "labels_format_valid",
    "display_points_valid",
    "geojson_structure_valid"
  ],
  "summary": {
    "total_features": 48,
    "by_type": {
      "address": 1,
      "venue": 1,
      "building": 1,
      "footprint": 3,
      "level": 3,
      "unit": 24,
      "opening": 8,
      "fixture": 4,
      "detail": 3
    },
    "error_count": 3,
    "warning_count": 5,
    "auto_fixable_count": 7,
    "checks_passed": 27,
    "checks_failed": 3,
    "unspecified_count": 2,
    "overlap_count": 1,
    "opening_issues_count": 2
  }
}
```

Note: `feature_id` is null for checks that apply globally
(like level ordinal gaps) rather than to a specific feature.
`related_feature_id` is included for pairwise checks like
overlapping units. `overlap_geometry` is included for
overlap warnings so the frontend can render the overlap
region on the map.

---

## 10. Future Enhancements (Nice to Have)

### 10.1 Two-Tier Validation

Extend the validator to distinguish between issues fixable
in-app (Tier 1) and issues that require Apple IMDF Sandbox
(Tier 2). Tier 2 issues are advisory and do not block
export.

Tier 2 issues:

- Georeferencing alignment with Apple satellite imagery
- Walkable area coverage for indoor survey
- Apple-specific business rules not in public IMDF spec
- Venue proximity to registered Apple Maps locations
- Opening placement tolerances (Apple applies stricter
  tolerances than the buffer-based check in 9.2)

### 10.2 Apple IMDF Schema Sync

Download and cache official IMDF JSON schema files from
Apple. Use with jsonschema for validation instead of
hand-coded checks. Include a "Check for schema updates"
action.

### 10.3 Full Undo/Redo for Review Screen

Extend the basic Ctrl+Z undo (which covers the last few
property edits) into a full undo/redo system tracking all
actions in the review screen: property edits, bulk
operations, deletions, and merge operations. Implement as
a command pattern with an action stack in the Zustand
store, each action storing the forward and reverse PATCH
payloads. Redo via Ctrl+Shift+Z / Ctrl+Y.

### 10.4 Saved Project Files

Save and reload project state (wizard configuration +
manual edits + validation state) as a project file, so
users can resume work across browser sessions. The backend
serializes the session to a JSON file that can be
downloaded and re-uploaded.

---

## 11. API Design

### 11.1 Session Model

The backend maintains a project session per import. A session
ID is returned on import and passed with subsequent requests.
Each session holds imported GeoDataFrames, detection results,
wizard configuration, mappings, generated features, and
validation state.

Session storage backend is configurable:

- `memory` (default): simplest mode for local development
- `filesystem` (recommended for shared single-PC deployment)
- `redis` (optional for multi-process or multi-host setups)

For filesystem mode, session data is written under
`SESSION_DATA_DIR`.

**Session cleanup:** Sessions expire after 24 hours of
inactivity (no API requests). A background task runs
every hour and prunes expired sessions to free memory.
TTL is configurable via `SESSION_TTL_HOURS` (default 24).

**Concurrent sessions:** Multiple users can have active
sessions simultaneously. Each `POST /api/import` creates
an independent session. To prevent memory exhaustion on
the shared PC, a maximum of 5 concurrent sessions is
enforced (configurable via `MAX_SESSIONS`). If the limit
is reached, the oldest inactive session is evicted.
The frontend shows a warning if the session was evicted
and prompts the user to re-upload.

With persistent backends (`filesystem` or `redis`), active
sessions should survive process restarts until TTL expiry.

### 11.1.1 Runtime Configuration

| Variable               | Default                 | Description                        |
| ---------------------- | ----------------------- | ---------------------------------- |
| `SESSION_TTL_HOURS`    | `24`                    | Session inactivity TTL in hours    |
| `MAX_SESSIONS`         | `5`                     | Maximum active sessions            |
| `SESSION_BACKEND`      | `memory`                | `memory`, `filesystem`, or `redis` |
| `SESSION_DATA_DIR`     | `./data/sessions`       | Filesystem backend storage path    |
| `PORT`                 | `8000`                  | API/server port                    |
| `HOST`                 | `0.0.0.0`               | API bind host                      |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated CORS origins       |
| `MAX_UPLOAD_MB`        | `1024`                  | Upload payload limit               |
| `LOG_LEVEL`            | `INFO`                  | Logging verbosity                  |

### 11.2 Endpoints

**Upload & Detection:**

| Method | Path                             | Description                       |
| ------ | -------------------------------- | --------------------------------- |
| POST   | `/api/import`                    | Upload shapefiles, create session |
| GET    | `/api/session/{id}/files`        | List files with detection results |
| POST   | `/api/session/{id}/detect`       | Re-run auto-detection             |
| PATCH  | `/api/session/{id}/files/{stem}` | Update file type/level            |

**Wizard Configuration:**

| Method | Path                                        | Description                 |
| ------ | ------------------------------------------- | --------------------------- |
| GET    | `/api/session/{id}/wizard`                  | Current wizard state        |
| PATCH  | `/api/session/{id}/wizard/project`          | Update project/venue info   |
| PATCH  | `/api/session/{id}/wizard/levels`           | Update level assignments    |
| PATCH  | `/api/session/{id}/wizard/buildings`        | Update building assignments |
| PATCH  | `/api/session/{id}/wizard/mappings`         | Update attribute mappings   |
| PATCH  | `/api/session/{id}/wizard/footprint`        | Update footprint method     |
| POST   | `/api/session/{id}/config/keywords`         | Upload keyword config       |
| POST   | `/api/session/{id}/config/company-mappings` | Upload company mappings     |

**Features (Review Screen):**

| Method | Path                               | Description               |
| ------ | ---------------------------------- | ------------------------- |
| GET    | `/api/session/{id}/features`       | All features as GeoJSON   |
| GET    | `/api/session/{id}/features/{fid}` | Single feature detail     |
| PATCH  | `/api/session/{id}/features/{fid}` | Update feature properties |
| PATCH  | `/api/session/{id}/features/bulk`  | Bulk update features      |
| DELETE | `/api/session/{id}/features/{fid}` | Delete a feature          |

**Generation, Validation & Export:**

| Method | Path                         | Description                 |
| ------ | ---------------------------- | --------------------------- |
| POST   | `/api/session/{id}/generate` | Generate addr/fp/bldg/venue |
| POST   | `/api/session/{id}/validate` | Run validation              |
| POST   | `/api/session/{id}/autofix`  | Auto-fix safe issues        |
| GET    | `/api/session/{id}/export`   | Download .imdf ZIP          |

### 11.3 Response Shapes

**Import response:**

```json
{
  "session_id": "abc-123",
  "files": [
    {
      "stem": "JRTokyoSta_GF_Space",
      "geometry_type": "Polygon",
      "feature_count": 10,
      "attribute_columns": ["NAME", "CATEGORY"],
      "detected_type": "unit",
      "detected_level": 0,
      "confidence": "green",
      "crs_detected": "EPSG:6677"
    }
  ],
  "cleanup_summary": {
    "multipolygons_exploded": 2,
    "rings_closed": 1,
    "features_reoriented": 5,
    "empty_features_dropped": 0,
    "coordinates_rounded": 48
  }
}
```

**Features GeoJSON response:**

The features endpoint returns all features including
generated Address and Building (unlocated) features.
Unlocated features (geometry: null) are included in the
response but are only shown in the table, not on the map.

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": "unit-uuid-here",
      "feature_type": "unit",
      "geometry": { "type": "Polygon", "coordinates": [...] },
      "properties": {
        "category": "room",
        "restriction": null,
        "accessibility": null,
        "name": { "en": "Main Lobby" },
        "alt_name": null,
        "level_id": "level-uuid-here",
        "display_point": { "type": "Point", "coordinates": [...] },
        "source_file": "JRTokyoSta_GF_Space",
        "status": "mapped",
        "issues": [],
        "metadata": { "ORIGINAL_COL": "value" }
      }
    },
    {
      "type": "Feature",
      "id": "addr-uuid-here",
      "feature_type": "address",
      "geometry": null,
      "properties": {
        "address": "1-9-1 Marunouchi",
        "unit": null,
        "locality": "Chiyoda-ku",
        "province": "JP-13",
        "country": "JP",
        "postal_code": "100-0005",
        "postal_code_ext": null,
        "postal_code_vanity": null,
        "status": "mapped",
        "issues": []
      }
    },
    {
      "type": "Feature",
      "id": "bldg-uuid-here",
      "feature_type": "building",
      "geometry": null,
      "properties": {
        "name": { "en": "Main Terminal" },
        "alt_name": null,
        "category": "unspecified",
        "restriction": null,
        "address_id": null,
        "display_point": { "type": "Point", "coordinates": [...] },
        "status": "mapped",
        "issues": []
      }
    },
    {
      "type": "Feature",
      "id": "detail-uuid-here",
      "feature_type": "detail",
      "geometry": { "type": "LineString", "coordinates": [...] },
      "properties": {
        "level_id": "level-uuid-here",
        "source_file": "JRTokyoSta_GF_Detail",
        "status": "mapped",
        "issues": [],
        "metadata": {}
      }
    }
  ]
}
```

**Validation response:** See Section 9.4 for the full
response shape including per-feature issues, overlap
geometry, and summary statistics.

**Auto-fix response:**

```json
{
  "fixes_applied": [
    {
      "feature_id": "uuid-here",
      "check": "invalid_geometry",
      "action": "make_valid",
      "description": "Repaired self-intersecting polygon"
    },
    {
      "feature_id": "uuid-here",
      "check": "excessive_precision",
      "action": "round_coordinates",
      "description": "Rounded coordinates to 7 decimal places"
    }
  ],
  "fixes_requiring_confirmation": [
    {
      "feature_id": "uuid-1",
      "related_feature_id": "uuid-2",
      "check": "duplicate_geometry",
      "action": "delete_duplicate",
      "description": "Delete duplicate of 'Room 105'",
      "requires_confirmation": true
    }
  ],
  "total_fixed": 7,
  "total_requiring_confirmation": 1,
  "revalidation": { "...validation response..." }
}
```

---

## 12. Build Order

Every phase ends with three deliverables:

1. **Implementation code** in `backend/` and/or `frontend/`
2. **Automated tests** in `backend/tests/`
3. **Testable app state** — something verifiable in the
   browser

### Phase 0: Test Fixtures

Create sample shapefiles in `backend/tests/fixtures/`.

**Fixture files:**

```
backend/tests/fixtures/
├── tokyo_station/
│   ├── JRTokyoSta_B1_Space.shp (+.shx, .dbf, .prj)
│   ├── JRTokyoSta_B1_Opening.shp (+.shx, .dbf, .prj)
│   ├── JRTokyoSta_B1_Detail.shp (+.shx, .dbf, .prj)
│   ├── JRTokyoSta_GF_Space.shp (+.shx, .dbf, .prj)
│   ├── JRTokyoSta_GF_Opening.shp (+.shx, .dbf, .prj)
│   ├── JRTokyoSta_GF_Fixture.shp (+.shx, .dbf, .prj)
│   ├── JRTokyoSta_1_Space.shp (+.shx, .dbf, .prj)
│   └── JRTokyoSta_1_Opening.shp (+.shx, .dbf, .prj)
├── edge_cases/
│   ├── no_prj_file.shp (+.shx, .dbf, NO .prj)
│   ├── mixed_geometry.shp (+.shx, .dbf, .prj)
│   ├── empty_file.shp (+.shx, .dbf, .prj)
│   ├── invalid_geometry.shp (+.shx, .dbf, .prj)
│   ├── overlapping_units.shp (+.shx, .dbf, .prj)
│   ├── multipolygon_units.shp (+.shx, .dbf, .prj)
│   ├── duplicate_geometry.shp (+.shx, .dbf, .prj)
│   ├── sliver_polygons.shp (+.shx, .dbf, .prj)
│   ├── detached_opening.shp (+.shx, .dbf, .prj)
│   └── flipped_coordinates.shp (+.shx, .dbf, .prj)
└── conftest.py
```

Generate with `backend/tests/generate_fixtures.py`.
The edge cases set includes geometry quality fixtures
that exercise the full validation suite.

**Deliverable:** Fixtures generate and load correctly.

---

### Phase 1: Foundation

**Backend:**

1. FastAPI project structure with Pydantic schemas
2. `backend/src/importer.py` — read, reproject, validate,
   convert to GeoJSON, plus import-time cleanup:
   MultiPolygon explosion, ring closure, winding order,
   empty geometry removal, coordinate rounding
3. `backend/src/models.py` — IMDF feature dataclasses
   matching the exact property structures from Section 2
4. `backend/src/schemas.py` — Pydantic request/response
   models (including `cleanup_summary`)
5. `backend/src/session.py` — session management abstraction
   with memory backend (Phase 1) plus pluggable persistent
   backends (filesystem/redis) and TTL cleanup
6. `POST /api/import` — accepts files, creates session,
   returns file list with cleanup summary
7. `GET /api/session/{id}/features` — returns GeoJSON

**Frontend:**

8. Scaffold React + Vite + TypeScript + Tailwind + Shadcn
9. Upload screen with `react-dropzone` drop zone and
   progress indicators
10. File upload POSTs to `/api/import`
11. Cleanup summary display on upload screen
12. Basic routing: Upload → Wizard → Review (empty shells)
13. Zustand store skeleton
14. Error boundary component

**Backend Tests:**

- Importer tests (read, CRS, reproject, validate, group)
- Import cleanup tests (MultiPolygon explosion, ring
  closure, winding order, empty removal, coordinate
  rounding)
- API endpoint tests (import, features GeoJSON)
- Session cleanup test (expired sessions are pruned)

**Testable app state:** Upload screen works. Drop files →
progress → cleanup summary shows. "Continue" button
appears. Backend returns session. Clicking Continue
navigates to wizard shell.

---

### Phase 2: Wizard — Detection & Classification

**Backend:**

15. `backend/src/detector.py` — keyword parsing, level
    detection, confidence scoring
16. `POST /api/session/{id}/detect`
17. `PATCH /api/session/{id}/files/{stem}`

**Frontend:**

18. Wizard shell with step sidebar, navigation, and
    "Skip to Summary" link
19. Auto-save indicator on wizard navigation bar
20. Step 2: File Classification table with auto-detection,
    editable dropdowns, confidence dots
21. Step 2: Preview map showing file geometry with
    hover-to-highlight and select-to-isolate interaction
22. Step 3: Level Mapping table with editable ordinals,
    short names, outdoor checkbox, and level category
23. Step 3: Stacking diagram with real-time reordering,
    duplicate detection, and gap visualization
24. Session learning prompt on relabel

**Backend Tests:**

- Detector tests (keywords, levels, learning, config)

**Testable app state:** Upload → wizard shows File
Classification with detected types. Preview map highlights
geometry on row hover. Level Mapping shows stacking diagram
that reorders as ordinals change. Short name and outdoor
fields visible. Session learning works.

---

### Phase 3: Wizard — Mapping & Generation Config

**Backend:**

25. `backend/src/mapper.py` — attribute mapping, category
    resolution, LABELS wrapping
26. Wizard state endpoints (PATCH project, levels,
    buildings, mappings, footprint)
27. `POST /api/session/{id}/config/company-mappings`
28. Address feature creation from structured wizard data
    (on project info save and building assignment save)

**Frontend:**

29. Step 1: Project Info form with required venue name,
    venue category, and structured address fields
    (address, locality, province, country, postal_code)
30. Step 4: Building Assignment with building category,
    building name, restriction, and per-building address
    toggle ("Same as venue" / "Different address")
31. Step 5: Unit Mapping with code column selector,
    company mappings upload, preview table showing all
    unique codes and their resolved categories
32. Step 6: Opening Mapping with category, accessibility,
    access_control, and door column mappings
33. Step 7: Fixture Mapping with name, alt_name, category
34. Step 8: Detail Mapping confirmation (no mappable
    properties)
35. Step 9: Footprint Options with method selector and
    preview
36. Step 10: Summary with address summary, warnings,
    cleanup summary, and confirm button
37. Skip to Summary functionality

**Backend Tests:**

- Mapper tests (code resolution, direct mapping, column
  detection, custom config, LABELS wrapping)
- Address creation tests (venue address, building address,
  same-as-venue default, missing street address uses name)

**Testable app state:** Full wizard flow from Project Info
through Summary. Venue name, category, and address required.
Upload company mappings → preview shows resolved categories
with unresolved codes highlighted. Skip to Summary works.
Confirm triggers generation.

---

### Phase 4: Review — Map & Table

**Backend:**

38. `backend/src/generator.py` — address, level, footprint,
    building (unlocated), venue generation, display points,
    unit/opening/fixture/detail property assembly
39. `POST /api/session/{id}/generate`
40. `PATCH /api/session/{id}/features/{fid}` — edit
41. `PATCH /api/session/{id}/features/bulk` — bulk edit
42. `DELETE /api/session/{id}/features/{fid}`

**Frontend:**

43. MapLibre canvas with GeoJSON sources and data-driven
    layers per located feature type, wrapped in error
    boundary. Detail rendered as thin LineString layer.
44. Layer tree with visibility checkboxes and level filter
    (located types only)
45. TanStack Table with filter bar, search, row selection,
    status column. Includes unlocated features (Address,
    Building) with adapted columns per type.
46. Zustand store: `selectedFeatureIds` drives map
    highlight and table selection bidirectionally
47. Properties panel with inline editing, relationship
    dropdowns (level_id, building_ids, address_id), and
    validation issue banner placeholder
48. Basic undo (Ctrl+Z) for property edits via Zustand
    edit history stack
49. Bulk actions (reassign level, change category, delete,
    merge)
50. "Back to Wizard" with confirmation dialog

**Backend Tests:**

- Generator tests (address generation, level union,
  footprint, building unlocated, venue, display points,
  building_ids on levels/footprints, LABELS on all names,
  UUIDs, referential integrity)

**Testable app state:** Upload → wizard → confirm → review
screen shows map with all located geometry colored by type.
Detail lines visible. Building and Address rows in table
but not on map. Layer toggles work. Click polygon → table
highlights. Click table row → map flies to feature. Filters
and search work. Edit a property → map updates. Ctrl+Z
undoes the edit.

---

### Phase 5: Validation & Export

**Backend:**

51. `backend/src/validator.py` — full validation suite:
    - Structural checks (hierarchy, references, UUIDs)
    - Address checks (exists, required properties,
      province, referential integrity)
    - Geometry type checks (including Detail = LineString,
      Building = null, Address = null)
    - Geometry validity checks (bounds, null island,
      empty, closed rings)
    - IMDF property checks (category, short_name, outdoor,
      building_ids, level_id, address_id, footprint
      category, LABELS format, display_points)
    - Geometry quality checks (overlaps, slivers,
      duplicates)
    - Spatial containment checks (units in levels,
      levels in footprints, footprints in venue)
    - Opening-specific checks (boundary touching,
      interior crossing, length anomalies, door property)
    - Detail-specific checks (degenerate lines, level
      containment)
    - Cross-level consistency checks (ordinal gaps,
      unit count disparity)
52. `backend/src/converter.py` — IMDF GeoJSON assembly
    with correct property structures per Section 2,
    address.geojson generation, building.geojson with
    null geometry, LABELS wrapping on all names
53. `POST /api/session/{id}/validate`
54. `POST /api/session/{id}/autofix` — applies safe fixes,
    returns prompted fixes requiring confirmation,
    re-validates automatically
55. `GET /api/session/{id}/export` — ZIP download

**Frontend:**

56. Validate button triggers validation, merges results
    into feature status column and issues array
57. Auto-filter to errors after validation, then to
    warnings when errors are resolved
58. Validation summary bar with counts, auto-fixable
    count, and auto-fix button
59. Validation issue banner in properties panel with
    per-issue descriptions and inline auto-fix buttons
60. Map validation overlay layers (red outlines for
    errors, yellow for warnings)
61. Overlap visualization layer (hatched red fill on
    overlap regions)
62. Export confirmation screen with summary, warning list,
    and download button
63. Disabled export when unresolved errors exist
64. Prompted auto-fix confirmation dialog for destructive
    fixes (delete duplicate, delete empty)

**Backend Tests (`backend/tests/test_validator.py`):**

Structural:

- `test_valid_output_passes`
- `test_missing_venue_error`
- `test_missing_building_error`
- `test_orphaned_reference_error`
- `test_duplicate_uuids_error`
- `test_geojson_structure_valid`

Address:

- `test_missing_address_error`
- `test_address_missing_required_fields`
- `test_address_province_required`
- `test_venue_missing_address_id`
- `test_building_address_id_valid`
- `test_orphaned_address_warning`

Geometry type:

- `test_opening_must_be_linestring`
- `test_detail_must_be_linestring`
- `test_unit_must_be_polygon`
- `test_building_must_be_null`
- `test_address_must_be_null`

Geometry validity:

- `test_invalid_geometry_error`
- `test_empty_geometry_error`
- `test_coordinates_out_of_bounds`
- `test_null_island_detection`
- `test_unclosed_ring_error`

IMDF properties:

- `test_unit_missing_category_error`
- `test_unit_missing_level_id_error`
- `test_opening_missing_category_error`
- `test_opening_missing_level_id_error`
- `test_fixture_missing_category_error`
- `test_fixture_missing_level_id_error`
- `test_detail_missing_level_id_error`
- `test_level_missing_ordinal_error`
- `test_level_missing_short_name_error`
- `test_level_missing_outdoor_error`
- `test_level_missing_building_ids_error`
- `test_venue_missing_address_error`
- `test_venue_missing_display_point_error`
- `test_footprint_missing_category_error`
- `test_footprint_missing_building_ids_error`
- `test_labels_format_valid`
- `test_display_point_within_geometry`
- `test_building_display_point_in_footprint`

Geometry quality:

- `test_overlapping_units_warning`
- `test_overlap_geometry_returned`
- `test_sliver_polygon_warning`
- `test_duplicate_geometry_warning`
- `test_small_geometry_warning`
- `test_large_geometry_warning`
- `test_flipped_coordinates_warning`
- `test_excessive_precision_warning`

Spatial containment:

- `test_unit_outside_level_warning`
- `test_unit_partially_outside_level`
- `test_level_outside_footprint_warning`
- `test_footprint_outside_venue_warning`

Openings:

- `test_opening_not_touching_boundary`
- `test_opening_crossing_interior`
- `test_opening_too_short`
- `test_opening_too_long`
- `test_opening_missing_door_warning`

Details:

- `test_detail_degenerate_line`
- `test_detail_outside_level`

Cross-level:

- `test_level_ordinal_gap`
- `test_unit_count_disparity`
- `test_level_no_units`
- `test_building_single_level`

**Backend Tests (`backend/tests/test_autofix.py`):**

- `test_autofix_invalid_geometry`
- `test_autofix_sliver_cleanup`
- `test_autofix_unclosed_ring`
- `test_autofix_winding_order`
- `test_autofix_excessive_precision`
- `test_autofix_multipolygon_explosion`
- `test_autofix_orphaned_unit`
- `test_autofix_missing_opening_level`
- `test_autofix_missing_detail_level`
- `test_autofix_duplicate_uuids`
- `test_autofix_footprint_outside_venue`
- `test_autofix_flipped_coordinates`
- `test_autofix_prompted_duplicate_deletion`
- `test_autofix_prompted_empty_deletion`
- `test_autofix_revalidates_after_fix`

**Backend Tests (`backend/tests/test_converter.py`):**

- `test_geojson_structure`
- `test_unique_uuids_are_strings`
- `test_feature_type_member_present`
- `test_relationship_references`
- `test_manifest_structure`
- `test_zip_archive_contents`
- `test_address_geojson_in_archive`
- `test_address_geometry_is_null`
- `test_address_required_properties`
- `test_building_geometry_is_null`
- `test_building_has_correct_properties`
- `test_venue_has_address_id`
- `test_level_has_building_ids`
- `test_level_has_outdoor`
- `test_footprint_has_building_ids`
- `test_unit_has_level_id`
- `test_opening_has_correct_properties`
- `test_opening_door_object_structure`
- `test_fixture_has_correct_properties`
- `test_detail_only_has_level_id`
- `test_labels_format_all_names`
- `test_display_points_within_geometry`
- `test_display_points_generated`
- `test_optional_files_omitted`
- `test_coordinate_precision`

**Testable app state:** Click Validate → table filters to
errors with status badges. Overlap regions visible on map
as hatched red areas. Click error → map highlights,
properties panel shows issue banner with fix guidance and
inline auto-fix buttons. Fix it → re-validate → error
gone, table shows warnings. Auto-fix all → prompted fixes
dialog → confirm → re-validates. Export → confirmation
screen → download valid .imdf ZIP. Verify ZIP contains
address.geojson with null geometry, building.geojson with
null geometry, detail.geojson with LineStrings, all names
in LABELS format.

---

### Phase 6: Polish

**Implementation:**

65. Error handling — API error codes, frontend toast
    notifications (Shadcn Toast)
66. Loading states — skeleton loaders during API calls
67. Edge cases (missing .prj, empty files, mixed geometry)
68. Keyboard shortcuts (Ctrl+Z undo, Escape deselect,
    Enter confirm)
69. Wizard step validation (prevent Next if required
    fields missing)
70. Session eviction warning in frontend
71. Production build: FastAPI serves `frontend/dist/`
72. Windows service setup documentation
73. README
74. `.env.example` documenting runtime variables
75. Setup smoke-test checklist in docs

**Backend Tests:**

- Edge case tests (missing .prj, empty, large datasets,
  bulk operations, session cleanup, concurrent sessions)

**Testable app state:** Full end-to-end flow from upload
through export. Edge cases handled gracefully. Loading
states visible. Toasts for errors. Polished and responsive.
Single `uvicorn` command serves everything.
