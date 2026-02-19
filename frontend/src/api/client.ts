import { ApiClientError, buildApiClientError } from "./errors";

export type CleanupSummary = {
  multipolygons_exploded: number;
  rings_closed: number;
  features_reoriented: number;
  empty_features_dropped: number;
  coordinates_rounded: number;
};

export type ImportedFile = {
  stem: string;
  geometry_type: string;
  feature_count: number;
  attribute_columns: string[];
  detected_type: string | null;
  detected_level: number | null;
  level_name: string | null;
  short_name: string | null;
  outdoor: boolean;
  level_category: string;
  confidence: string;
  crs_detected: string | null;
  warnings: string[];
};

export type ImportResponse = {
  session_id: string;
  files: ImportedFile[];
  cleanup_summary: CleanupSummary;
  warnings: string[];
};

export type DetectResponse = {
  session_id: string;
  files: ImportedFile[];
};

export type LearningSuggestion = {
  source_stem: string;
  keyword: string;
  feature_type: string;
  affected_stems: string[];
  message: string;
};

export type UpdateFileRequest = {
  detected_type?: string | null;
  detected_level?: number | null;
  level_name?: string | null;
  short_name?: string | null;
  outdoor?: boolean | null;
  level_category?: string | null;
  apply_learning?: boolean;
  learning_keyword?: string | null;
};

export type UpdateFileResponse = {
  session_id: string;
  file: ImportedFile;
  files: ImportedFile[];
  save_status: "saved";
  learning_suggestion: LearningSuggestion | null;
};

export type AddressInput = {
  address: string | null;
  unit: string | null;
  locality: string;
  province: string | null;
  country: string;
  postal_code: string | null;
  postal_code_ext: string | null;
  postal_code_vanity: string | null;
};

export type ProjectWizardState = {
  project_name: string | null;
  venue_name: string;
  venue_category: string;
  language: string;
  venue_restriction: string | null;
  venue_hours: string | null;
  venue_phone: string | null;
  venue_website: string | null;
  address: AddressInput;
};

export type LevelWizardItem = {
  stem: string;
  detected_type: string | null;
  ordinal: number | null;
  name: string | null;
  short_name: string | null;
  outdoor: boolean;
  category: string;
};

export type BuildingWizardState = {
  id: string;
  name: string | null;
  category: string;
  restriction: string | null;
  file_stems: string[];
  address_mode: "same_as_venue" | "different_address";
  address: AddressInput | null;
  address_feature_id: string | null;
};

export type UnitCodePreviewRow = {
  code: string;
  count: number;
  resolved_category: string;
  unresolved: boolean;
};

export type UnitMappingState = {
  code_column: string | null;
  name_column: string | null;
  alt_name_column: string | null;
  restriction_column: string | null;
  accessibility_column: string | null;
  preview: UnitCodePreviewRow[];
};

export type OpeningMappingState = {
  category_column: string | null;
  accessibility_column: string | null;
  access_control_column: string | null;
  door_automatic_column: string | null;
  door_material_column: string | null;
  door_type_column: string | null;
  name_column: string | null;
};

export type FixtureMappingState = {
  name_column: string | null;
  alt_name_column: string | null;
  category_column: string | null;
};

export type WizardMappingsState = {
  unit: UnitMappingState;
  opening: OpeningMappingState;
  fixture: FixtureMappingState;
  detail_confirmed: boolean;
};

export type FootprintWizardState = {
  method: "union_buffer" | "convex_hull" | "concave_hull";
  footprint_buffer_m: number;
  venue_buffer_m: number;
};

export type WizardState = {
  project: ProjectWizardState | null;
  levels: {
    items: LevelWizardItem[];
  };
  buildings: BuildingWizardState[];
  mappings: WizardMappingsState;
  footprint: FootprintWizardState;
  company_mappings: Record<string, string>;
  company_default_category: string;
  venue_address_feature: Record<string, unknown> | null;
  building_address_features: Record<string, unknown>[];
  warnings: string[];
  generation_status: "not_started" | "draft_ready" | "generated";
};

export type WizardStateResponse = {
  session_id: string;
  wizard: WizardState;
};

export type ProjectWizardResponse = {
  session_id: string;
  wizard: WizardState;
  address_feature: Record<string, unknown>;
};

export type BuildingsWizardResponse = {
  session_id: string;
  wizard: WizardState;
  address_features: Record<string, unknown>[];
};

export type MappingsWizardRequest = {
  unit?: UnitMappingState;
  opening?: OpeningMappingState;
  fixture?: FixtureMappingState;
  detail_confirmed?: boolean;
};

export type CompanyMappingsUploadResponse = {
  session_id: string;
  default_category: string;
  mappings_count: number;
  preview: UnitCodePreviewRow[];
  unresolved_count: number;
};

export type GenerateResponse = {
  session_id: string;
  status: "draft" | "generated";
  generated_feature_count: number;
  message: string;
};

export type FeatureItem = {
  type: "Feature";
  id: string;
  feature_type: string;
  geometry: Record<string, unknown> | null;
  properties: Record<string, unknown>;
};

export type FeaturePatchRequest = {
  properties?: Record<string, unknown>;
  geometry?: Record<string, unknown> | null;
};

export type BulkFeaturePatchRequest = {
  feature_ids: string[];
  action?: "patch" | "delete" | "merge_units";
  properties?: Record<string, unknown>;
  merge_name?: string | null;
};

export type BulkFeaturePatchResponse = {
  updated_count: number;
  deleted_count: number;
  merged_feature_id: string | null;
};

export type ValidationIssue = {
  feature_id: string | null;
  related_feature_id?: string | null;
  check: string;
  message: string;
  severity: "error" | "warning";
  auto_fixable: boolean;
  fix_description?: string | null;
  overlap_geometry?: Record<string, unknown> | null;
};

export type ValidationSummary = {
  total_features: number;
  by_type: Record<string, number>;
  error_count: number;
  warning_count: number;
  auto_fixable_count: number;
  checks_passed: number;
  checks_failed: number;
  unspecified_count: number;
  overlap_count: number;
  opening_issues_count: number;
};

export type ValidationResponse = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  passed: string[];
  summary: ValidationSummary;
};

export type AutofixApplied = {
  feature_id: string | null;
  related_feature_id?: string | null;
  check: string;
  action: string;
  description: string;
};

export type AutofixPrompt = {
  feature_id: string | null;
  related_feature_id?: string | null;
  check: string;
  action: string;
  description: string;
  requires_confirmation: boolean;
};

export type AutofixResponse = {
  fixes_applied: AutofixApplied[];
  fixes_requiring_confirmation: AutofixPrompt[];
  total_fixed: number;
  total_requiring_confirmation: number;
  revalidation: ValidationResponse;
};

export type ExportArchiveResponse = {
  blob: Blob;
  filename: string;
};

export async function importShapefiles(
  files: File[],
  onProgress?: (percent: number) => void
): Promise<ImportResponse> {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/import");

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) {
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as ImportResponse);
        } catch {
          reject(new ApiClientError(request.status, "INVALID_RESPONSE", "Import returned invalid JSON."));
        }
        return;
      }
      reject(buildApiClientError(request.status, request.responseText || ""));
    };

    request.onerror = () => reject(new ApiClientError(0, "NETWORK_ERROR", "Network error during upload."));
    request.send(formData);
  });
}

async function handleJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw buildApiClientError(response.status, body || "");
  }
  return (await response.json()) as T;
}

export async function fetchSessionFiles(sessionId: string): Promise<{ session_id: string; files: ImportedFile[] }> {
  const response = await fetch(`/api/session/${sessionId}/files`);
  return handleJson<{ session_id: string; files: ImportedFile[] }>(response);
}

export async function detectAllFiles(sessionId: string): Promise<DetectResponse> {
  const response = await fetch(`/api/session/${sessionId}/detect`, {
    method: "POST"
  });
  return handleJson<DetectResponse>(response);
}

export async function updateSessionFile(
  sessionId: string,
  stem: string,
  payload: UpdateFileRequest
): Promise<UpdateFileResponse> {
  const response = await fetch(`/api/session/${sessionId}/files/${encodeURIComponent(stem)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return handleJson<UpdateFileResponse>(response);
}

export async function fetchSessionFeatures(
  sessionId: string
): Promise<{ type: "FeatureCollection"; features: Record<string, unknown>[] }> {
  const response = await fetch(`/api/session/${sessionId}/features`);
  return handleJson<{ type: "FeatureCollection"; features: Record<string, unknown>[] }>(response);
}

export async function fetchSessionFeature(sessionId: string, featureId: string): Promise<FeatureItem> {
  const response = await fetch(`/api/session/${sessionId}/features/${encodeURIComponent(featureId)}`);
  return handleJson<FeatureItem>(response);
}

export async function patchSessionFeature(
  sessionId: string,
  featureId: string,
  payload: FeaturePatchRequest
): Promise<FeatureItem> {
  const response = await fetch(`/api/session/${sessionId}/features/${encodeURIComponent(featureId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return handleJson<FeatureItem>(response);
}

export async function patchSessionFeaturesBulk(
  sessionId: string,
  payload: BulkFeaturePatchRequest
): Promise<BulkFeaturePatchResponse> {
  const response = await fetch(`/api/session/${sessionId}/features/bulk`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return handleJson<BulkFeaturePatchResponse>(response);
}

export async function deleteSessionFeature(
  sessionId: string,
  featureId: string
): Promise<{ session_id: string; deleted_id: string }> {
  const response = await fetch(`/api/session/${sessionId}/features/${encodeURIComponent(featureId)}`, {
    method: "DELETE"
  });
  return handleJson<{ session_id: string; deleted_id: string }>(response);
}

export async function fetchWizardState(sessionId: string): Promise<WizardStateResponse> {
  const response = await fetch(`/api/session/${sessionId}/wizard`);
  return handleJson<WizardStateResponse>(response);
}

export async function patchWizardProject(
  sessionId: string,
  payload: ProjectWizardState
): Promise<ProjectWizardResponse> {
  const response = await fetch(`/api/session/${sessionId}/wizard/project`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return handleJson<ProjectWizardResponse>(response);
}

export async function patchWizardLevels(
  sessionId: string,
  items: LevelWizardItem[]
): Promise<WizardStateResponse> {
  const response = await fetch(`/api/session/${sessionId}/wizard/levels`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ items })
  });
  return handleJson<WizardStateResponse>(response);
}

export async function patchWizardBuildings(
  sessionId: string,
  buildings: BuildingWizardState[]
): Promise<BuildingsWizardResponse> {
  const response = await fetch(`/api/session/${sessionId}/wizard/buildings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ buildings })
  });
  return handleJson<BuildingsWizardResponse>(response);
}

export async function patchWizardMappings(
  sessionId: string,
  payload: MappingsWizardRequest
): Promise<WizardStateResponse> {
  const response = await fetch(`/api/session/${sessionId}/wizard/mappings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return handleJson<WizardStateResponse>(response);
}

export async function patchWizardFootprint(
  sessionId: string,
  payload: FootprintWizardState
): Promise<WizardStateResponse> {
  const response = await fetch(`/api/session/${sessionId}/wizard/footprint`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return handleJson<WizardStateResponse>(response);
}

export async function uploadCompanyMappings(
  sessionId: string,
  file: File
): Promise<CompanyMappingsUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`/api/session/${sessionId}/config/company-mappings`, {
    method: "POST",
    body: formData
  });
  return handleJson<CompanyMappingsUploadResponse>(response);
}

export async function generateSessionDraft(sessionId: string): Promise<GenerateResponse> {
  const response = await fetch(`/api/session/${sessionId}/generate`, {
    method: "POST"
  });
  return handleJson<GenerateResponse>(response);
}

export async function validateSession(sessionId: string): Promise<ValidationResponse> {
  const response = await fetch(`/api/session/${sessionId}/validate`, {
    method: "POST"
  });
  return handleJson<ValidationResponse>(response);
}

export async function autofixSession(sessionId: string, applyPrompted = false): Promise<AutofixResponse> {
  const response = await fetch(`/api/session/${sessionId}/autofix`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ apply_prompted: applyPrompted })
  });
  return handleJson<AutofixResponse>(response);
}

export async function exportSessionArchive(sessionId: string): Promise<ExportArchiveResponse> {
  const response = await fetch(`/api/session/${sessionId}/export`);
  if (!response.ok) {
    const body = await response.text();
    throw buildApiClientError(response.status, body || "");
  }
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] ?? "output.imdf"
  };
}
