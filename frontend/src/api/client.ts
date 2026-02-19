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
