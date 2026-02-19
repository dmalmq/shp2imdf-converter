import { create } from "zustand";

import type { CleanupSummary, ImportedFile, LearningSuggestion, WizardState } from "../api/client";

type Screen = "upload" | "wizard" | "review";
type SaveStatus = "idle" | "saving" | "saved" | "error";

type Filters = {
  type?: string;
  level?: string;
  category?: string;
  status?: string;
  search?: string;
};

type ValidationResults = {
  errors: number;
  warnings: number;
};

type AppState = {
  sessionId: string | null;
  currentScreen: Screen;
  wizardStep: number;
  wizardData: Record<string, unknown>;
  geojsonData: Record<string, unknown> | null;
  selectedFeatureIds: string[];
  filters: Filters;
  layerVisibility: Record<string, boolean>;
  validationResults: ValidationResults;
  editHistory: Array<Record<string, unknown>>;
  files: ImportedFile[];
  cleanupSummary: CleanupSummary | null;
  wizardState: WizardState | null;
  selectedFileStem: string | null;
  hoveredFileStem: string | null;
  wizardSaveStatus: SaveStatus;
  wizardSaveError: string | null;
  learningSuggestion: LearningSuggestion | null;
  setSessionId: (sessionId: string | null) => void;
  setCurrentScreen: (screen: Screen) => void;
  setWizardStep: (step: number) => void;
  mergeWizardData: (payload: Record<string, unknown>) => void;
  setGeojsonData: (payload: Record<string, unknown> | null) => void;
  setFiles: (files: ImportedFile[]) => void;
  setCleanupSummary: (summary: CleanupSummary | null) => void;
  setWizardState: (wizardState: WizardState | null) => void;
  setSelectedFeatureIds: (ids: string[]) => void;
  toggleSelectedFeatureId: (id: string, multi?: boolean) => void;
  clearSelectedFeatureIds: () => void;
  setFilters: (filters: Filters) => void;
  setLayerVisibility: (layerVisibility: Record<string, boolean>) => void;
  setValidationResults: (results: ValidationResults) => void;
  pushEditHistory: (entry: Record<string, unknown>) => void;
  popEditHistory: () => Record<string, unknown> | null;
  upsertFile: (file: ImportedFile) => void;
  setSelectedFileStem: (stem: string | null) => void;
  setHoveredFileStem: (stem: string | null) => void;
  setWizardSaveStatus: (status: SaveStatus, error?: string | null) => void;
  setLearningSuggestion: (suggestion: LearningSuggestion | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  sessionId: null,
  currentScreen: "upload",
  wizardStep: 0,
  wizardData: {},
  geojsonData: null,
  selectedFeatureIds: [],
  filters: {},
  layerVisibility: {},
  validationResults: { errors: 0, warnings: 0 },
  editHistory: [],
  files: [],
  cleanupSummary: null,
  wizardState: null,
  selectedFileStem: null,
  hoveredFileStem: null,
  wizardSaveStatus: "idle",
  wizardSaveError: null,
  learningSuggestion: null,
  setSessionId: (sessionId) => set({ sessionId }),
  setCurrentScreen: (currentScreen) => set({ currentScreen }),
  setWizardStep: (wizardStep) => set({ wizardStep }),
  mergeWizardData: (payload) =>
    set((state) => ({ wizardData: { ...state.wizardData, ...payload } })),
  setGeojsonData: (geojsonData) => set({ geojsonData }),
  setFiles: (files) => set({ files }),
  setCleanupSummary: (cleanupSummary) => set({ cleanupSummary }),
  setWizardState: (wizardState) => set({ wizardState }),
  setSelectedFeatureIds: (selectedFeatureIds) => set({ selectedFeatureIds }),
  toggleSelectedFeatureId: (id, multi = false) =>
    set((state) => {
      const current = state.selectedFeatureIds;
      if (multi) {
        if (current.includes(id)) {
          return { selectedFeatureIds: current.filter((item) => item !== id) };
        }
        return { selectedFeatureIds: [...current, id] };
      }
      if (current.length === 1 && current[0] === id) {
        return { selectedFeatureIds: [] };
      }
      return { selectedFeatureIds: [id] };
    }),
  clearSelectedFeatureIds: () => set({ selectedFeatureIds: [] }),
  setFilters: (filters) => set({ filters }),
  setLayerVisibility: (layerVisibility) => set({ layerVisibility }),
  setValidationResults: (validationResults) => set({ validationResults }),
  pushEditHistory: (entry) => set((state) => ({ editHistory: [...state.editHistory, entry] })),
  popEditHistory: () => {
    let popped: Record<string, unknown> | null = null;
    set((state) => {
      if (state.editHistory.length === 0) {
        popped = null;
        return state;
      }
      const next = [...state.editHistory];
      popped = next.pop() ?? null;
      return { editHistory: next };
    });
    return popped;
  },
  upsertFile: (file) =>
    set((state) => ({
      files: state.files.map((item) => (item.stem === file.stem ? file : item))
    })),
  setSelectedFileStem: (selectedFileStem) => set({ selectedFileStem }),
  setHoveredFileStem: (hoveredFileStem) => set({ hoveredFileStem }),
  setWizardSaveStatus: (wizardSaveStatus, wizardSaveError = null) => set({ wizardSaveStatus, wizardSaveError }),
  setLearningSuggestion: (learningSuggestion) => set({ learningSuggestion })
}));
