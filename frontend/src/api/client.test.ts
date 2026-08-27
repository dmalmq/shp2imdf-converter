import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadReferenceLayers, matchIllustratorShape, type IllustratorShapeMatchRequest, type IllustratorShapeMatchResponse } from "./client";

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

describe("matchIllustratorShape", () => {
  const payload: IllustratorShapeMatchRequest = {
    floor_label: "1F",
    artwork: { source_table: "unit_1f", source_row: 3 },
    current_transform: {
      artwork_anchor: [85, 80],
      map_anchor: [139.700258, 35.690921],
      rotation_deg: 0,
      metres_per_point: 0.176389,
      working_crs: "EPSG:6677"
    },
    scale_locked: true,
    reference: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [139.7, 35.69],
                [139.71, 35.69],
                [139.71, 35.7],
                [139.7, 35.7],
                [139.7, 35.69]
              ]
            ]
          }
        }
      ]
    }
  };

  const responseBody: IllustratorShapeMatchResponse = {
    matches: [
      {
        rank: 1,
        score: 0.91,
        relative_gap: null,
        reference_feature_index: 0,
        reference_part_index: 0,
        transform: payload.current_transform,
        boundary_rmse_m: 0.42,
        boundary_p95_m: 0.8,
        max_residual_m: 1.1,
        overlap_iou: 0.87,
        reference_geometry: payload.reference.features[0]!.geometry!,
        residual_vectors: [
          {
            artwork: [139.7001, 35.6909],
            reference: [139.7002, 35.691],
            distance_m: 0.42
          }
        ]
      }
    ]
  };

  it("POSTs the request JSON to /shape-matches and returns typed matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(responseBody));
    vi.stubGlobal("fetch", fetchMock);

    const result: IllustratorShapeMatchResponse = await matchIllustratorShape("conv-1", payload);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/convert/illustrator/conv-1/shape-matches");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(result).toEqual(responseBody);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.relative_gap).toBeNull();
  });

  it("surfaces HTTP errors through handleJson", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ detail: "no polygon matches", code: "BAD_REQUEST" })
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(matchIllustratorShape("conv-1", payload)).rejects.toMatchObject({
      name: "ApiClientError",
      status: 400,
      code: "BAD_REQUEST",
      detail: "no polygon matches"
    });
  });
});
