export type Place = { name: string; lngLat: [number, number] };

export type NonEmpty<T> = readonly [T, ...T[]];

export type Located =
  | { kind: "none" }
  | { kind: "locating"; query: string }
  | { kind: "guessed"; place: Place; candidates: NonEmpty<Place> }
  | { kind: "chosen"; place: Place; candidates: NonEmpty<Place> };

export type SearchOutcome =
  | { kind: "idle" }
  | { kind: "pending"; query: string }
  | { kind: "hits"; places: NonEmpty<Place> }
  | { kind: "empty" }
  | { kind: "unavailable" };

export type Search =
  | { kind: "collapsed" }
  | { kind: "open"; query: string; outcome: SearchOutcome };

export type LocateState = { located: Located; search: Search };

export type LocateEvent =
  | { type: "armFilename"; query: string }
  | { type: "guessed"; candidates: readonly Place[] }
  | { type: "open"; siteName: string }
  | { type: "close" }
  | { type: "editQuery"; query: string }
  | { type: "submitted" }
  | { type: "settled"; query: string; places: readonly Place[] }
  | { type: "faulted"; query: string }
  | { type: "picked"; place: Place };

export const INITIAL_LOCATE: LocateState = {
  located: { kind: "none" },
  search: { kind: "collapsed" }
};

export function isNonEmpty<T>(items: readonly T[]): items is NonEmpty<T> {
  return items.length > 0;
}

export function acceptsGuess(state: LocateState): boolean {
  return state.located.kind === "locating" && state.search.kind === "collapsed";
}

export function samePlace(a: Place, b: Place): boolean {
  return a.lngLat[0] === b.lngLat[0] && a.lngLat[1] === b.lngLat[1];
}

export function cachedCandidates(located: Located): NonEmpty<Place> | null {
  if (located.kind === "guessed" || located.kind === "chosen") return located.candidates;
  return null;
}

export function locatedPlace(located: Located): Place | null {
  if (located.kind === "guessed" || located.kind === "chosen") return located.place;
  return null;
}

export function toPlace(item: {
  display_name: string;
  longitude: number;
  latitude: number;
}): Place {
  return { name: item.display_name, lngLat: [item.longitude, item.latitude] };
}

function pendingMatches(
  search: Search,
  query: string
): search is { kind: "open"; query: string; outcome: { kind: "pending"; query: string } } {
  return (
    search.kind === "open" && search.outcome.kind === "pending" && search.outcome.query === query
  );
}

function hitsFromLocated(located: Located): SearchOutcome {
  const cached = cachedCandidates(located);
  return cached ? { kind: "hits", places: cached } : { kind: "idle" };
}

export function locateReducer(state: LocateState, event: LocateEvent): LocateState {
  switch (event.type) {
    case "armFilename": {
      if (state.located.kind !== "none" && state.located.kind !== "locating") return state;
      return { located: { kind: "locating", query: event.query }, search: { kind: "collapsed" } };
    }
    case "guessed": {
      if (!acceptsGuess(state)) return state;
      if (!isNonEmpty(event.candidates)) {
        return { located: { kind: "none" }, search: { kind: "collapsed" } };
      }
      return {
        located: {
          kind: "guessed",
          place: event.candidates[0],
          candidates: event.candidates
        },
        search: { kind: "collapsed" }
      };
    }
    case "open": {
      const query =
        state.search.kind === "open" && !event.siteName ? state.search.query : event.siteName;
      return { ...state, search: { kind: "open", query, outcome: hitsFromLocated(state.located) } };
    }
    case "close":
      return { ...state, search: { kind: "collapsed" } };
    case "editQuery": {
      if (state.search.kind !== "open") return state;
      const current = state.search.outcome;
      const outcome: SearchOutcome =
        current.kind === "pending" && current.query === event.query
          ? current
          : current.kind === "pending"
            ? { kind: "idle" }
            : current;
      return { ...state, search: { kind: "open", query: event.query, outcome } };
    }
    case "submitted": {
      if (state.search.kind !== "open") return state;
      const query = state.search.query.trim();
      if (!query) return state;
      return {
        ...state,
        search: { kind: "open", query: state.search.query, outcome: { kind: "pending", query } }
      };
    }
    case "settled": {
      if (!pendingMatches(state.search, event.query)) return state;
      return {
        ...state,
        search: {
          kind: "open",
          query: state.search.query,
          outcome: isNonEmpty(event.places)
            ? { kind: "hits", places: event.places }
            : { kind: "empty" }
        }
      };
    }
    case "faulted": {
      if (!pendingMatches(state.search, event.query)) return state;
      return {
        ...state,
        search: {
          kind: "open",
          query: state.search.query,
          outcome: { kind: "unavailable" }
        }
      };
    }
    case "picked": {
      const fromHits =
        state.search.kind === "open" && state.search.outcome.kind === "hits"
          ? state.search.outcome.places
          : cachedCandidates(state.located);
      const candidates: NonEmpty<Place> = fromHits ?? [event.place];
      return {
        located: { kind: "chosen", place: event.place, candidates },
        search: { kind: "collapsed" }
      };
    }
  }
}
