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
};

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
