/** Full-width to half-width (NFKC), lower case, one space between words. */
export function norm(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const WORD_BREAK = /[\s_\-・·./]+/;

/** Words of a normalised string, for word-prefix matching. */
export function words(text: string): string[] {
  return text.split(WORD_BREAK).filter(Boolean);
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;

/** `東京駅1f` → `東京駅`, `1f`: runs split where CJK meets anything else. */
export function splitScripts(term: string): string[] {
  const parts: string[] = [];
  let current = "";
  let currentCjk: boolean | null = null;
  for (const char of term) {
    const cjk = CJK.test(char);
    if (currentCjk !== null && cjk !== currentCjk) {
      parts.push(current);
      current = "";
    }
    current += char;
    currentCjk = cjk;
  }
  if (current) parts.push(current);
  return parts;
}

const ALNUM = /[a-z0-9]/;

/** Whether a match of `key` ending at `end` stops at a boundary in `text`. */
export function endsAtBoundary(text: string, key: string, end: number): boolean {
  if (end >= text.length) return true;
  const last = key[key.length - 1];
  return !(last && ALNUM.test(last) && ALNUM.test(text[end]));
}

/**
 * Every spelling of a floor label that finds it, normalised. The label is
 * matched whole; anything the table does not recognise is only itself.
 */
export function floorAliases(label: string): string[] {
  const key = norm(label);
  const found = new Set<string>([key]);
  let match: RegExpExecArray | null;
  if ((match = /^(\d+(?:\.\d+)?)(?:f|階)$/.exec(key))) {
    const n = match[1];
    found.add(`${n}f`).add(`${n}階`);
  } else if ((match = /^(?:b|地下)(\d+)(?:f|階)?$/.exec(key))) {
    const n = match[1];
    found.add(`b${n}f`).add(`b${n}`).add(`地下${n}階`).add(`地下${n}f`);
  } else if ((match = /^(?:m|中)(\d+)(?:f|階)?$/.exec(key))) {
    const n = match[1];
    found.add(`m${n}f`).add(`m${n}`).add(`中${n}階`);
  } else if (key === "rf" || key === "r" || key === "屋上") {
    found.add("rf").add("r").add("屋上");
  }
  return [...found];
}
