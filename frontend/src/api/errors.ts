export type ApiErrorPayload = {
  detail?: string;
  code?: string;
};

export class ApiClientError extends Error {
  status: number;
  code: string;
  detail: string;
  /**
   * True when the server itself supplied the detail. False when we synthesised it
   * from a bare status, which is what an unreachable API looks like: the dev proxy
   * answers a refused connection with a bodiless 5xx. Every error the API raises
   * carries an ErrorResponse body, so the absence of one is a real signal.
   */
  serverProvidedDetail: boolean;

  constructor(status: number, code: string, detail: string, serverProvidedDetail = false) {
    super(detail || "Request failed");
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.detail = detail || "Request failed";
    this.serverProvidedDetail = serverProvidedDetail;
  }
}

function parseApiErrorPayload(raw: string): ApiErrorPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const detail = "detail" in parsed && typeof parsed.detail === "string" ? parsed.detail : undefined;
    const code = "code" in parsed && typeof parsed.code === "string" ? parsed.code : undefined;
    if (!detail && !code) {
      return null;
    }
    return { detail, code };
  } catch {
    return null;
  }
}

function fallbackCode(status: number): string {
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 400) {
    return "BAD_REQUEST";
  }
  if (status === 401) {
    return "UNAUTHORIZED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status >= 500) {
    return "INTERNAL_ERROR";
  }
  return "REQUEST_FAILED";
}

export function buildApiClientError(status: number, bodyText: string): ApiClientError {
  const parsed = parseApiErrorPayload(bodyText);
  if (parsed) {
    return new ApiClientError(status, parsed.code ?? fallbackCode(status), parsed.detail ?? "Request failed", true);
  }
  // A body we could not parse is still the server talking - Starlette answers an
  // unhandled exception with plain "Internal Server Error". Only an empty body
  // means nothing answered.
  const body = bodyText.trim();
  if (body) {
    return new ApiClientError(status, fallbackCode(status), body, true);
  }
  return new ApiClientError(status, fallbackCode(status), `Request failed (${status})`, false);
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

export function toErrorMessage(error: unknown, fallback: string): string {
  if (isApiClientError(error)) {
    return error.detail;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export function isSessionNotFoundError(error: unknown): boolean {
  return isApiClientError(error) && error.code === "SESSION_NOT_FOUND";
}

/**
 * A request that never reached the API: a stopped backend, a proxy aimed at the
 * wrong port, or no network at all. Worth separating from a real API error,
 * because the two need opposite reactions from the user - check the server
 * versus fix the input - and a screen that guesses wrong sends people hunting
 * for a problem in a file that is fine.
 *
 * Every error the API raises carries an ErrorResponse body, and Starlette
 * answers even an unhandled exception with plain text, so a 5xx with nothing in
 * it did not come from the app. The dev proxy reports a refused connection that
 * way; a fetch with no proxy in front of it rejects with a TypeError instead.
 */
export function isBackendUnreachableError(error: unknown): boolean {
  if (isApiClientError(error)) {
    return error.status === 0 || error.code === "NETWORK_ERROR" || (error.status >= 500 && !error.serverProvidedDetail);
  }
  return error instanceof TypeError;
}
