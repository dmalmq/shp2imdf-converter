import { norm, splitTerm, words } from "./normalize";
import type { SearchItem, SearchKind } from "./types";

export const KIND_ORDER: ReadonlyArray<SearchKind> = ["station", "floor", "issue", "file", "action"];

export const PER_GROUP = 5;

export type ResultGroup = { kind: SearchKind; items: SearchItem[]; total: number };

export type SearchResult = { groups: ResultGroup[]; count: number; empty: SearchKind[] };

function quality(term: string, candidate: string): number {
  if (candidate === term) return 4;
  if (candidate.startsWith(term)) return 3;
  if (words(candidate).some((word) => word.startsWith(term))) return 2;
  return candidate.includes(term) ? 1 : 0;
}

function best(term: string, item: SearchItem): number {
  let found = 0;
  for (const candidate of item.terms) {
    found = Math.max(found, quality(term, candidate));
    if (found === 4) break;
  }
  return found;
}

/**
 * The query's units: its whitespace terms, except that a term nothing matches
 * whole is split where scripts meet (`東京駅1f` → `東京駅`, `1f`).
 */
function units(query: string, items: readonly SearchItem[]): string[] {
  return norm(query)
    .split(" ")
    .filter(Boolean)
    .flatMap((term) => (items.some((item) => best(term, item) > 0) ? [term] : splitTerm(term)));
}

type Scored = { item: SearchItem; covered: number; quality: number; order: number };

export function search(items: readonly SearchItem[], query: string): SearchResult {
  const terms = units(query, items);
  if (terms.length === 0) return { groups: [], count: 0, empty: [] };

  const scored: Scored[] = [];
  items.forEach((item, order) => {
    let covered = 0;
    let total = 0;
    for (const term of terms) {
      const found = best(term, item);
      if (found > 0) {
        covered += 1;
        total += found;
      }
    }
    if (covered > 0) scored.push({ item, covered, quality: total, order });
  });

  const byKind = new Map<SearchKind, Scored[]>();
  for (const entry of scored) byKind.set(entry.item.kind, [...(byKind.get(entry.item.kind) ?? []), entry]);

  const rank = (a: Scored, b: Scored) => b.covered - a.covered || b.quality - a.quality || a.order - b.order;
  const groups = [...byKind.entries()].map(([kind, entries]) => {
    const sorted = [...entries].sort(rank);
    return { kind, sorted };
  });
  groups.sort(
    (a, b) => rank(a.sorted[0], b.sorted[0]) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  );

  return {
    groups: groups.map(({ kind, sorted }) => ({
      kind,
      items: sorted.slice(0, PER_GROUP).map((entry) => entry.item),
      total: sorted.length
    })),
    count: scored.length,
    empty: KIND_ORDER.filter((kind) => kind !== "action" && !byKind.has(kind))
  };
}

/** Match strings for an item: each given string normalised, plus a file name without its extension. */
export function termsOf(...values: ReadonlyArray<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = norm(value);
    if (!key) continue;
    found.add(key);
    const dot = key.lastIndexOf(".");
    if (dot > 0) found.add(key.slice(0, dot));
  }
  return [...found];
}
