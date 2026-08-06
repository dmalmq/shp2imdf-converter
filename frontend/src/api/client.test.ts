import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadReferenceLayers } from "./client";

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadReferenceLayers", () => {
  it("appends focus_bounds as minLon,minLat,maxLon,maxLat when supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ layers: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadReferenceLayers([new File(["x"], "station.shp")], [139.7, 35.69, 139.71, 35.7]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/reference-layers");
    const body = init.body as FormData;
    // The exact field the backend parses; a comma-joined lon/lat box, not JSON.
    expect(body.get("focus_bounds")).toBe("139.7,35.69,139.71,35.7");
    expect(body.get("files")).toBeInstanceOf(File);
  });

  it("sends no focus_bounds field when none is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ layers: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadReferenceLayers([new File(["x"], "station.shp")]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.has("focus_bounds")).toBe(false);
    expect(body.get("files")).toBeInstanceOf(File);
  });
});
