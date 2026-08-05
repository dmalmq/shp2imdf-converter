import { describe, expect, it } from "vitest";

import {
  ApiClientError,
  buildApiClientError,
  isBackendUnreachableError,
  toErrorMessage
} from "./errors";

describe("buildApiClientError", () => {
  it("keeps the API's own detail and code", () => {
    const error = buildApiClientError(
      422,
      JSON.stringify({ detail: "Not a PDF-based Illustrator file.", code: "ILLUSTRATOR_CONVERSION_FAILED" })
    );
    expect(error.detail).toBe("Not a PDF-based Illustrator file.");
    expect(error.code).toBe("ILLUSTRATOR_CONVERSION_FAILED");
    expect(error.serverProvidedDetail).toBe(true);
  });

  it("treats an unparseable body as the server still talking", () => {
    // Starlette answers an unhandled exception with exactly this, not JSON.
    const error = buildApiClientError(500, "Internal Server Error");
    expect(error.detail).toBe("Internal Server Error");
    expect(error.serverProvidedDetail).toBe(true);
  });

  it("marks an empty body as not coming from the server", () => {
    const error = buildApiClientError(500, "");
    expect(error.serverProvidedDetail).toBe(false);
  });
});

describe("isBackendUnreachableError", () => {
  it("flags the bodiless 5xx a dev proxy returns for a refused connection", () => {
    // The exact shape observed in the browser when the API port has nothing on
    // it: status 500, empty body. This is the regression this predicate exists
    // for - it used to be indistinguishable from a real server error.
    expect(isBackendUnreachableError(buildApiClientError(500, ""))).toBe(true);
  });

  it("does not flag a 5xx the API actually raised", () => {
    const raised = buildApiClientError(500, JSON.stringify({ detail: "QGIS export failed.", code: "QGIS_EXPORT_FAILED" }));
    expect(isBackendUnreachableError(raised)).toBe(false);
  });

  it("does not flag a 4xx that rejects the input", () => {
    const rejected = buildApiClientError(
      422,
      JSON.stringify({ detail: "Not a PDF-based Illustrator file.", code: "ILLUSTRATOR_CONVERSION_FAILED" })
    );
    expect(isBackendUnreachableError(rejected)).toBe(false);
  });

  it("flags the XHR upload path's network error", () => {
    expect(isBackendUnreachableError(new ApiClientError(0, "NETWORK_ERROR", "Network error during upload."))).toBe(true);
  });

  it("flags a fetch rejection, which arrives as a TypeError", () => {
    expect(isBackendUnreachableError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("does not flag an ordinary error", () => {
    expect(isBackendUnreachableError(new Error("boom"))).toBe(false);
    expect(isBackendUnreachableError(null)).toBe(false);
  });
});

describe("toErrorMessage", () => {
  it("prefers the API detail over the caller's fallback", () => {
    const error = buildApiClientError(422, JSON.stringify({ detail: "Re-save the .ai.", code: "X" }));
    expect(toErrorMessage(error, "fallback")).toBe("Re-save the .ai.");
  });

  it("falls back when there is nothing to report", () => {
    expect(toErrorMessage({}, "fallback")).toBe("fallback");
  });
});
