import { create } from "zustand";

type Screen = "upload" | "wizard" | "review";

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
  setSessionId: (sessionId: string | null) => void;
  setCurrentScreen: (screen: Screen) => void;
  setWizardStep: (step: number) => void;
  mergeWizardData: (payload: Record<string, unknown>) => void;
  setGeojsonData: (payload: Record<string, unknown> | null) => void;
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
  setSessionId: (sessionId) => set({ sessionId }),
  setCurrentScreen: (currentScreen) => set({ currentScreen }),
  setWizardStep: (wizardStep) => set({ wizardStep }),
  mergeWizardData: (payload) =>
    set((state) => ({ wizardData: { ...state.wizardData, ...payload } })),
  setGeojsonData: (geojsonData) => set({ geojsonData })
}));

