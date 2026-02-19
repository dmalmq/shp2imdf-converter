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
  generation_status: "not_started" | "draft_ready";
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
  status: "draft";
  generated_feature_count: number;
  message: string;
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
        resolve(JSON.parse(request.responseText) as ImportResponse);
        return;
      }
      reject(new Error(request.responseText || "Import failed"));
    };

    request.onerror = () => reject(new Error("Network error during upload"));
    request.send(formData);
  });
}

async function handleJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed (${response.status})`);
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
