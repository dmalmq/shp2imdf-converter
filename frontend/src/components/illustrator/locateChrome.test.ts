import {
  INITIAL_LOCATE,
  acceptsGuess,
  locateReducer,
  samePlace,
  toPlace,
  type LocateState,
  type Place
} from "./locateChrome";

const oimachiSta: Place = { name: "大井町駅, 品川区, 東京都", lngLat: [139.7286, 35.6063] };
const oimachiTown: Place = { name: "大井町, 足柄上郡, 神奈川県", lngLat: [139.117, 35.322] };

test("filename guess stays collapsed, open lists those hits, pick chooses and collapses", () => {
  let s = locateReducer(INITIAL_LOCATE, { type: "armFilename", query: "大井町" });
  expect(s.located).toEqual({ kind: "locating", query: "大井町" });
  s = locateReducer(s, { type: "guessed", candidates: [oimachiSta, oimachiTown] });
  expect(s).toEqual({
    located: { kind: "guessed", place: oimachiSta, candidates: [oimachiSta, oimachiTown] },
    search: { kind: "collapsed" }
  });
  s = locateReducer(s, { type: "open", siteName: "大井町" });
  expect(s.search).toEqual({
    kind: "open",
    query: "大井町",
    outcome: { kind: "hits", places: [oimachiSta, oimachiTown] }
  });
  s = locateReducer(s, { type: "picked", place: oimachiTown });
  expect(s).toEqual({
    located: { kind: "chosen", place: oimachiTown, candidates: [oimachiSta, oimachiTown] },
    search: { kind: "collapsed" }
  });
  s = locateReducer(s, { type: "open", siteName: "大井町" });
  expect(s.search.outcome).toEqual({ kind: "hits", places: [oimachiSta, oimachiTown] });
});

test("a reply for a query the user has moved on from is dropped", () => {
  const pendingShinjuku: LocateState = {
    located: { kind: "none" },
    search: { kind: "open", query: "新宿", outcome: { kind: "pending", query: "新宿" } }
  };
  const s = locateReducer(pendingShinjuku, {
    type: "settled",
    query: "大井町",
    places: [oimachiSta]
  });
  expect(s).toBe(pendingShinjuku);
});

test("guessed with no candidates leaves none, and a later guess is ignored once the user acted", () => {
  expect(locateReducer(INITIAL_LOCATE, { type: "guessed", candidates: [] })).toBe(INITIAL_LOCATE);
  const locating = locateReducer(INITIAL_LOCATE, { type: "armFilename", query: "大井町" });
  expect(locateReducer(locating, { type: "guessed", candidates: [] })).toEqual({
    located: { kind: "none" },
    search: { kind: "collapsed" }
  });
  const opened = locateReducer(INITIAL_LOCATE, { type: "open", siteName: "大井町" });
  expect(locateReducer(opened, { type: "guessed", candidates: [oimachiSta] })).toBe(opened);
  const chosen: LocateState = {
    located: { kind: "chosen", place: oimachiTown, candidates: [oimachiTown] },
    search: { kind: "collapsed" }
  };
  expect(locateReducer(chosen, { type: "guessed", candidates: [oimachiSta] })).toBe(chosen);
});

test("open without a guessed place is idle; close keeps located", () => {
  const opened = locateReducer(INITIAL_LOCATE, { type: "open", siteName: "大井町" });
  expect(opened).toEqual({
    located: { kind: "none" },
    search: { kind: "open", query: "大井町", outcome: { kind: "idle" } }
  });
  expect(locateReducer(opened, { type: "close" })).toEqual({
    located: { kind: "none" },
    search: { kind: "collapsed" }
  });
});

test("submitted starts pending; settled and faulted apply only to that query", () => {
  const opened = locateReducer(INITIAL_LOCATE, { type: "open", siteName: "  新宿  " });
  const typed = locateReducer(opened, { type: "editQuery", query: "  新宿  " });
  const pending = locateReducer(typed, { type: "submitted" });
  expect(pending.search).toEqual({
    kind: "open",
    query: "  新宿  ",
    outcome: { kind: "pending", query: "新宿" }
  });
  expect(locateReducer(pending, { type: "settled", query: "新宿", places: [] }).search.outcome).toEqual({
    kind: "empty"
  });
  expect(locateReducer(pending, { type: "faulted", query: "新宿" }).search.outcome).toEqual({
    kind: "unavailable"
  });
  expect(locateReducer(pending, { type: "settled", query: "新宿", places: [oimachiSta] }).search.outcome).toEqual({
    kind: "hits",
    places: [oimachiSta]
  });
  expect(locateReducer(pending, { type: "faulted", query: "大井町" })).toBe(pending);
});

test("editQuery while pending stays pending only when the query is unchanged", () => {
  const pending: LocateState = {
    located: { kind: "none" },
    search: { kind: "open", query: "新宿", outcome: { kind: "pending", query: "新宿" } }
  };
  expect(locateReducer(pending, { type: "editQuery", query: "新宿" }).search.outcome).toEqual({
    kind: "pending",
    query: "新宿"
  });
  const edited = locateReducer(pending, { type: "editQuery", query: "新宿駅" });
  expect(edited.search).toEqual({
    kind: "open",
    query: "新宿駅",
    outcome: { kind: "idle" }
  });
  expect(locateReducer(edited, { type: "settled", query: "新宿", places: [oimachiSta] })).toBe(edited);
  expect(locateReducer(INITIAL_LOCATE, { type: "editQuery", query: "新宿" })).toBe(INITIAL_LOCATE);
  expect(locateReducer(INITIAL_LOCATE, { type: "submitted" })).toBe(INITIAL_LOCATE);
});

test("acceptsGuess, samePlace, and toPlace", () => {
  expect(acceptsGuess(INITIAL_LOCATE)).toBe(false);
  expect(
    acceptsGuess({
      located: { kind: "locating", query: "大井町" },
      search: { kind: "collapsed" }
    })
  ).toBe(true);
  expect(
    acceptsGuess({
      located: { kind: "guessed", place: oimachiSta, candidates: [oimachiSta] },
      search: { kind: "collapsed" }
    })
  ).toBe(false);
  expect(samePlace(oimachiSta, { name: "other", lngLat: [139.7286, 35.6063] })).toBe(true);
  expect(samePlace(oimachiSta, oimachiTown)).toBe(false);
  expect(
    toPlace({ display_name: "大井町駅", longitude: 139.7286, latitude: 35.6063 })
  ).toEqual({ name: "大井町駅", lngLat: [139.7286, 35.6063] });
});
