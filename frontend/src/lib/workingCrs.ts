const JPR_ROMAN = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
  "XV",
  "XVI",
  "XVII",
  "XVIII",
  "XIX"
] as const;

/** Same wording as backend ``zone_label`` for JPR EPSG codes. */
export function workingCrsLabel(crs: string): string {
  const code = Number(crs.split(":")[1]);
  if (Number.isInteger(code) && code >= 6669 && code <= 6687) {
    return `${crs} — JPR CS ${JPR_ROMAN[code - 6669]}`;
  }
  return crs;
}
