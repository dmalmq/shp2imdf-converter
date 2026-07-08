/**
 * Unit category color palette synced from RevitGeoExporter
 * Source: RevitGeoExporter.Core/Models/ImdfUnitCategoryCatalog.cs
 */

export const UNIT_CATEGORY_COLORS: Record<string, string> = {
  // Official IMDF categories
  auditorium: "#D8E8FF",
  brick: "#C9856B",
  classroom: "#FFF2B3",
  column: "#BDBDBD",
  concrete: "#C8C8C8",
  conferenceroom: "#CCE5FF",
  drywall: "#E8E2D8",
  elevator: "#E0E0E0",
  escalator: "#D0D0D0",
  fieldofplay: "#CFE8C6",
  firstaid: "#FFD3D3",
  fitnessroom: "#E2FFD7",
  foodservice: "#FFE4C6",
  footbridge: "#E6F3FF",
  glass: "#EAF8FF",
  huddleroom: "#DDEBFF",
  kitchen: "#FFF1D1",
  laboratory: "#EADFFF",
  library: "#F7F0D8",
  lobby: "#F4F4D1",
  lounge: "#F5E6FF",
  mailroom: "#EFEFEF",
  mothersroom: "#FFE0F0",
  movietheater: "#D7D7FF",
  movingwalkway: "#E8F6FF",
  nonpublic: "#F3F3F3",
  office: "#E8F4FF",
  opentobelow: "#F8F8F8",
  parking: "#E3E3E3",
  phoneroom: "#D9EBFF",
  platform: "#FFF6F3",
  privatelounge: "#E8D9FF",
  ramp: "#E9E9E9",
  recreation: "#E2FFD2",
  restroom: "#D9FFD9",
  "restroom.family": "#D9FFD9",
  "restroom.female": "#FFA4A4",
  "restroom.female.wheelchair": "#FFB8B8",
  "restroom.male": "#BBD2EF",
  "restroom.male.wheelchair": "#CDE0F6",
  "restroom.transgender": "#E3D4FF",
  "restroom.transgender.wheelchair": "#EDE2FF",
  "restroom.unisex": "#D9FFD9",
  "restroom.unisex.wheelchair": "#E8FFE8",
  "restroom.wheelchair": "#E8FFE8",
  road: "#E4E5E5",
  room: "#F7F7F7",
  serverroom: "#D8D8E8",
  shower: "#DFF7FF",
  smokingarea: "#E2D9D9",
  stairs: "#C0C0C0",
  steps: "#C6C6C6",
  storage: "#EFE6D8",
  structure: "#C2C2C2",
  terrace: "#F6F2E2",
  theater: "#DDD8FF",
  unenclosedarea: "#FAFAFA",
  unspecified: "#CCCCCC",
  vegetation: "#D8F0D2",
  waitingroom: "#BABABA",
  walkway: "#FFFFFF",
  "walkway.island": "#F2F2F2",
  wood: "#C89E6E",
  // Legacy categories
  retail: "#E1F3F9",
  information: "#EFEFF9",
  ticketing: "#C2E389",
  outdoors: "#FFFFFF",
  // GSI categories with no IMDF equivalent above
  publicfacility: "#D6EDE7",
};

// GSI Space category codes (e.g. Space.shp "category" = "B001") map 1:1 to the IMDF
// names above via backend/config/b-codes.json. ODC2026 imports keep the raw code as
// the unit's category (see imdf_shapefile_importer.py), so alias each code to the
// same color as its IMDF equivalent for a consistent preview.
const SPACE_CODE_TO_CATEGORY: Record<string, string> = {
  B001: "retail",
  B002: "office",
  B003: "publicfacility",
  B004: "waitingroom",
  B005: "ticketing",
  B006: "information",
  B007: "restroom.male",
  B008: "restroom.female",
  B009: "restroom.unisex",
  B010: "restroom",
  B011: "restroom",
  B012: "restroom",
  B013: "restroom",
  B014: "restroom",
  B015: "smokingarea",
  B016: "mothersroom",
  B017: "firstaid",
  B018: "room",
  B019: "room",
  B020: "opentobelow",
  B021: "stairs",
  B022: "elevator",
  B023: "escalator",
  B024: "walkway",
  B025: "walkway",
  B026: "nonpublic",
  B027: "parking",
  B028: "platform",
  B029: "walkway",
  B030: "footbridge", // pedestrian deck
  B031: "footbridge", // pedestrian overpass
  B999: "outdoors", // ground level, outside the building
};

for (const [code, category] of Object.entries(SPACE_CODE_TO_CATEGORY)) {
  const color = UNIT_CATEGORY_COLORS[category];
  if (color) {
    UNIT_CATEGORY_COLORS[code] = color;
  }
}

const UNIT_FALLBACK_COLOR = "#CCCCCC";
const UNIT_STROKE_COLOR = "#94a3b8";

function buildCategoryMatchExpr(): unknown[] {
  const entries: unknown[] = ["match", ["get", "category"]];
  for (const [cat, color] of Object.entries(UNIT_CATEGORY_COLORS)) {
    entries.push(cat, color);
  }
  entries.push(UNIT_FALLBACK_COLOR);
  return entries;
}

export function buildUnitFillColorExpr(
  featureTypeProp: string,
  nonUnitEntries: unknown[]
): unknown[] {
  return [
    "case",
    ["==", ["get", featureTypeProp], "unit"],
    buildCategoryMatchExpr(),
    ["match", ["get", featureTypeProp], ...nonUnitEntries],
  ];
}

export function buildUnitLineColorExpr(
  featureTypeProp: string,
  nonUnitEntries: unknown[]
): unknown[] {
  return [
    "case",
    ["==", ["get", featureTypeProp], "unit"],
    UNIT_STROKE_COLOR,
    ["match", ["get", featureTypeProp], ...nonUnitEntries],
  ];
}

export function buildUnitOpacityExpr(
  featureTypeProp: string,
  unitOpacity: number,
  defaultOpacity: number
): unknown[] {
  return [
    "case",
    ["==", ["get", featureTypeProp], "unit"],
    unitOpacity,
    defaultOpacity,
  ];
}
