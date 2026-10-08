import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachmentFilename,
  convertColorTheme,
  exportIllustrator,
  exportSessionArchive,
  exportSessionShapefiles,
  fetchColorTheme,
  fetchPreloadedReferenceLayers,
  getPreloadedReferenceOverlay,
  importShapefiles,
  inspectColorTheme,
  matchIllustratorShape,
  uploadReferenceLayers,
  type DatasetFile,
  type IllustratorShapeMatchRequest,
  type IllustratorShapeMatchResponse,
  type ShapefileExportRequest
} from "./client";

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload
  } as unknown as Response;
}

function fileResponse(disposition: string | null): Response {
  return {
    ok: true,
    blob: async () => new Blob(["zip"]),
    headers: { get: (name: string) => (name.toLowerCase() === "content-disposition" ? disposition : null) }
  } as unknown as Response;
}

/** Stands in for XMLHttpRequest: records what was sent and answers when told to. */
class FakeRequest {
  static sent: FakeRequest[] = [];
  method = "";
  url = "";
  body: unknown = null;
  status = 0;
  responseType = "";
  responseText = "";
  response: unknown = null;
  headers: Record<string, string> = {};
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: unknown) {
    this.body = body;
    FakeRequest.sent.push(this);
  }

  abort() {
    this.onabort?.();
  }

  getResponseHeader(name: string): string | null {
    return this.headers[name.toLowerCase()] ?? null;
  }

  /** Answers the way a browser would for the `responseType` the client asked for. */
  respond(status: number, text: string, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
    if (this.responseType === "arraybuffer") this.response = new TextEncoder().encode(text).buffer;
    else this.responseText = text;
    this.onload?.();
  }
}

function lastRequest(): FakeRequest {
  const request = FakeRequest.sent.at(-1);
  if (!request) throw new Error("nothing was sent");
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRequest.sent = [];
});

describe("shapefile import upload", () => {
  const imported = { session_id: "s1", import_profile: "standard", files: [], cleanup_summary: {}, warnings: [] };

  it("posts every file as `files`, reports whole-percent progress and resolves the server's JSON", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const progress: number[] = [];
    const files = [new File(["a"], "JRTokyoSta_1_Space.shp"), new File(["b"], "JRTokyoSta_1_Space.dbf")];

    const pending = importShapefiles(files, (percent) => progress.push(percent));
    const request = lastRequest();
    expect([request.method, request.url]).toEqual(["POST", "/api/import"]);
    expect((request.body as FormData).getAll("files")).toEqual(files);
    request.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 });
    request.upload.onprogress?.({ lengthComputable: false, loaded: 2, total: 0 });
    request.respond(200, JSON.stringify(imported));

    await expect(pending).resolves.toEqual(imported);
    expect(progress).toEqual([33]);
  });

  it("rejects with the server's detail and code, so the toast says what went wrong", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = importShapefiles([new File(["a"], "a.shp")]);
    lastRequest().respond(400, JSON.stringify({ detail: "Upload exceeds 200 MB", code: "UPLOAD_TOO_LARGE" }));
    await expect(pending).rejects.toMatchObject({ status: 400, code: "UPLOAD_TOO_LARGE", detail: "Upload exceeds 200 MB" });
  });

  it("rejects a 2xx that is not JSON instead of resolving garbage", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = importShapefiles([new File(["a"], "a.shp")]);
    lastRequest().respond(200, "<html>proxy</html>");
    await expect(pending).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects as a network error when nothing answers", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = importShapefiles([new File(["a"], "a.shp")]);
    lastRequest().onerror?.();
    await expect(pending).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });
});

describe("colour theme upload", () => {
  const files: DatasetFile[] = [
    { file: new File(["a"], "JRTokyoSta_1_Space.dbf"), path: "JRTokyoSta_6677.shp/JRTokyoSta_1_Space.dbf" },
    { file: new File(["b"], "JRTokyoSta_1_Space.dbf"), path: "JRTokyoSta_6677.shp/sub/JRTokyoSta_1_Space.dbf" },
    { file: new File(["c"], "acad.err"), path: "JRTokyoSta_6677.shp/acad.err" }
  ];

  it("sends each file with its path, pairwise and in order", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = inspectColorTheme(files, {});
    const request = lastRequest();
    expect([request.method, request.url]).toEqual(["POST", "/api/color-theme/inspect"]);
    const form = request.body as FormData;
    expect([...form.entries()].map(([name]) => name)).toEqual(["files", "paths", "files", "paths", "files", "paths"]);
    expect(form.getAll("files")).toEqual(files.map(({ file }) => file));
    expect(form.getAll("paths")).toEqual(files.map(({ path }) => path));
    request.respond(200, JSON.stringify({ dataset: { name: "JRTokyoSta_6677" } }));
    await expect(pending).resolves.toMatchObject({ dataset: { name: "JRTokyoSta_6677" } });
  });

  it("downloads the converted zip as bytes, under the server's Japanese name", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = convertColorTheme(files, { styleFiles: false });
    const request = lastRequest();
    expect(request.url).toBe("/api/color-theme/convert");
    expect(request.responseType).toBe("arraybuffer");
    request.respond(200, "PK zip bytes", {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="_new-colors.zip"; filename*=UTF-8''%E6%9D%B1%E4%BA%AC_new-colors.zip`
    });
    const { blob, filename } = await pending;
    expect(filename).toBe("東京_new-colors.zip");
    expect(blob.size).toBe("PK zip bytes".length);
    expect(blob.type).toBe("application/zip");
  });

  it.each([true, false])("tells the server whether the zip is to carry style files: %s", async (styleFiles) => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = convertColorTheme(files, { styleFiles });
    const request = lastRequest();
    const form = request.body as FormData;
    expect(form.getAll("style_files")).toEqual([String(styleFiles)]);
    expect(form.getAll("paths")).toEqual(files.map(({ path }) => path));
    request.respond(200, "PK", { "content-type": "application/zip" });
    await pending;
  });

  it("still reports the server's error when the answer was asked for as bytes", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const pending = convertColorTheme(files, { styleFiles: false });
    lastRequest().respond(400, JSON.stringify({ detail: "Two files differ only in case", code: "CASE_COLLISION" }));
    await expect(pending).rejects.toMatchObject({ status: 400, code: "CASE_COLLISION", detail: "Two files differ only in case" });
  });

  it("rejects with an AbortError when the caller aborts, as fetch would", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const controller = new AbortController();
    const pending = inspectColorTheme(files, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("GETs the mapping to show before any upload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ field: "color2", rules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchColorTheme()).resolves.toEqual({ field: "color2", rules: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/color-theme");
  });
});

describe("attachmentFilename", () => {
  it("decodes filename*, which is the only form that carries a Japanese name", () => {
    expect(
      attachmentFilename(
        `attachment; filename="JRTokyoSta_6677_new-colors.zip"; filename*=UTF-8''%E6%9D%B1%E4%BA%AC_new-colors.zip`,
        "output.zip"
      )
    ).toBe("東京_new-colors.zip");
  });

  it("reads a quoted or bare filename when there is no filename*", () => {
    expect(attachmentFilename('attachment; filename="Tokyo Station.imdf"', "output.imdf")).toBe("Tokyo Station.imdf");
    expect(attachmentFilename("attachment; filename=tokyo.zip", "output.zip")).toBe("tokyo.zip");
  });

  it("falls back when the header names nothing or is absent", () => {
    expect(attachmentFilename("attachment", "output.zip")).toBe("output.zip");
    expect(attachmentFilename(null, "output.zip")).toBe("output.zip");
  });
});

describe("downloads are named by the server", () => {
  const request = { mode: "source_update" } as ShapefileExportRequest;

  it("prefers the UTF-8 name, so a Japanese station keeps its name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fileResponse(`attachment; filename="_.zip"; filename*=UTF-8''%E6%9D%B1%E4%BA%AC%E9%A7%85.zip`)
      )
    );
    const result = await exportIllustrator("c1", { floors: [], output_crs: "EPSG:6677", formats: { geopackage: true, shapefile: false, qgis: false } });
    expect(result.filename).toBe("東京駅.zip");
  });

  it("uses the plain name when that is all the header has", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fileResponse('attachment; filename="JRTokyoSta_odc2026.zip"')));
    expect((await exportSessionShapefiles("s1", request)).filename).toBe("JRTokyoSta_odc2026.zip");
  });

  it("falls back to the endpoint's default name when there is no header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fileResponse(null)));
    expect((await exportSessionArchive("s1")).filename).toBe("output.imdf");
    expect((await exportSessionArchive("s1", true)).filename).toBe("output.zip");
  });
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

describe("preloaded reference overlay", () => {
  it("GETs availability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ available: true, label: "駅データ" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPreloadedReferenceOverlay()).resolves.toEqual({
      available: true,
      label: "駅データ"
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/reference-layers/preloaded");
  });

  it("POSTs the pin box and include_lines without files", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ layers: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPreloadedReferenceLayers([140.1134, 35.6132, 140.1134, 35.6132], true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/reference-layers/preloaded");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      focus_bounds: "140.1134,35.6132,140.1134,35.6132",
      include_lines: true
    });
    expect(init.body).not.toBeInstanceOf(FormData);
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
