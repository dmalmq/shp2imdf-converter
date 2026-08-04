/**
 * Building name to search for, derived from an Illustrator file name.
 *
 * Drawings are named like `0307_大井町.ai` — a work-order number, then the
 * station or building. The number, the extension and any copy suffix carry no
 * location, so they are dropped and remaining separators become spaces. A
 * trailing number group is dropped too, because it is usually a CRS or sheet
 * code (`JRShinjukuSta_6677`).
 *
 * Returns "" when nothing but numbering remains; callers must not search then.
 */
export function siteNameFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const name = base
    .replace(/\.[^.]+$/, "") // extension
    .replace(/^(?:\d+[\s_.-]+)+/, "") // leading work-order / date numbers
    .replace(/\s*\(\d+\)$/, "") // "(1)" duplicate suffix
    .replace(/(?:[\s_.-]+\d+)+$/, "") // trailing CRS / sheet number
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^\d*$/.test(name) ? "" : name;
}
