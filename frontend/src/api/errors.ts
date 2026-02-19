export type ApiErrorPayload = {
  detail?: string;
  code?: string;
};

export class ApiClientError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(status: number, code: string, detail: string) {
    super(detail || "Request failed");
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.detail = detail || "Request failed";
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
    return new ApiClientError(status, parsed.code ?? fallbackCode(status), parsed.detail ?? "Request failed");
  }
  const detail = bodyText.trim() || `Request failed (${status})`;
  return new ApiClientError(status, fallbackCode(status), detail);
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
