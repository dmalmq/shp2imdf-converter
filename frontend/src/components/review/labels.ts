/**
 * IMDF labels are language maps (`{ ja: "改札", en: "Ticket gate" }`), and an
 * edit touches one language of them, never the whole map.
 *
 * The project language is only a preference: the IMDF-archive import never
 * sets it, so it arrives as a blind "en". When a label has no entry for it, the
 * language the label actually carries is the one shown and edited, so a `{ ja }`
 * name stays Japanese instead of being saved back as `{ en }`.
 */

function labelEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
}

/** The language an edit of `value` should write: `preferred` unless the label only carries others. */
export function labelLanguage(value: unknown, preferred: string): string {
  const entries = labelEntries(value);
  if (entries.length === 0 || entries.some(([language]) => language === preferred)) {
    return preferred;
  }
  return entries[0][0];
}

export function labelText(value: unknown, language?: string): string {
  if (typeof value === "string") {
    return value;
  }
  const entries = labelEntries(value);
  const match = entries.find(([key]) => key === language) ?? entries[0];
  return match ? match[1] : "";
}

/** `value` with `language` set to `text`; clearing drops only that language, and an emptied map becomes null. */
export function setLabelText(value: unknown, language: string, text: string): Record<string, unknown> | null {
  const next: Record<string, unknown> =
    value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  if (text) {
    next[language] = text;
  } else {
    delete next[language];
  }
  return Object.keys(next).length > 0 ? next : null;
}
