import { useMemo } from "react";
import { create } from "zustand";

import type {
  BuildingWizardState,
  CleanupSummary,
  FootprintWizardState,
  ImportedFile,
  LearningSuggestion,
  ProjectWizardState,
  WizardState
} from "../api/client";

/**
 * Wizard form edits the server does not have yet: waiting out the autosave
 * delay, or held because the server would refuse them. A section with no
 * draft shows the saved state. Kept here rather than in the page so leaving
 * /wizard and coming back within the session does not drop a held draft.
 */
export type WizardDrafts = {
  project: ProjectWizardState | null;
  buildings: BuildingWizardState[] | null;
  footprint: FootprintWizardState | null;
};

const NO_DRAFTS: WizardDrafts = { project: null, buildings: null, footprint: null };

type Screen = "upload" | "wizard" | "review";
/** The Illustrator route has its own three stages, unrelated to the wizard's. */
export type IllustratorStage = 1 | 2 | 3;
type SaveStatus = "idle" | "saving" | "saved" | "error";
export type UiLanguage = "en" | "ja";
export type Theme = "light" | "dark";
export type ImportProfile = "standard" | "imdf_shapefile";

/** What a project needs on arrival for its stages to be resolved and drawn. */
export type LoadedProject = {
  importProfile: ImportProfile;
  files: ImportedFile[];
  wizardState?: WizardState | null;
  /** Check has something to show: a draft was generated, or the import needs no Set up. */
  reviewReached: boolean;
};

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
  uiLanguage: UiLanguage;
  theme: Theme;
  sessionId: string | null;
  /** The project whose files, profile and stage the store holds; null while it loads. */
  loadedSessionId: string | null;
  importProfile: ImportProfile;
  sessionExpiredMessage: string | null;
  currentScreen: Screen;
  illustratorStage: IllustratorStage;
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
  /** When the last save succeeded, for the footer's "Saved · HH:MM". */
  wizardSavedAt: number | null;
  /** Re-runs the save that just failed; cleared by the next status change. */
  wizardSaveRetry: (() => void) | null;
  wizardDrafts: WizardDrafts;
  setWizardDraft: <K extends keyof WizardDrafts>(section: K, draft: WizardDrafts[K]) => void;
  learningSuggestion: LearningSuggestion | null;
  setUiLanguage: (language: UiLanguage) => void;
  setTheme: (theme: Theme) => void;
  /**
   * Makes `sessionId` the store's project. Everything that belongs to the
   * previous project goes with it; display preferences stay.
   */
  switchProject: (sessionId: string | null) => void;
  /** Fills in the project just switched to; ignored if the store has since moved on. */
  projectLoaded: (sessionId: string, project: LoadedProject) => void;
  setImportProfile: (profile: ImportProfile) => void;
  setSessionExpiredMessage: (message: string | null) => void;
  clearSession: () => void;
  setCurrentScreen: (screen: Screen) => void;
  setIllustratorStage: (stage: IllustratorStage) => void;
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
  setWizardSaveStatus: (status: SaveStatus, error?: string | null, retry?: (() => void) | null) => void;
  setLearningSuggestion: (suggestion: LearningSuggestion | null) => void;
};

/** Saved choice wins; otherwise follow the OS so nobody has to opt in. */
function readInitialTheme(): Theme {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem("ui_theme");
    if (saved === "light" || saved === "dark") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  }
  return "light";
}

function readInitialLanguage(): UiLanguage {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem("ui_language");
    if (saved === "en" || saved === "ja") {
      return saved;
    }
    if (window.navigator.language.toLowerCase().startsWith("ja")) {
      return "ja";
    }
  }
  return "en";
}

const INITIAL_STATE = {
  uiLanguage: readInitialLanguage(),
  theme: readInitialTheme(),
  sessionId: null as string | null,
  loadedSessionId: null as string | null,
  importProfile: "standard" as ImportProfile,
  sessionExpiredMessage: null,
  currentScreen: "upload" as Screen,
  illustratorStage: 1 as IllustratorStage,
  wizardStep: 0,
  wizardData: {} as Record<string, unknown>,
  geojsonData: null as Record<string, unknown> | null,
  selectedFeatureIds: [] as string[],
  filters: {} as Filters,
  layerVisibility: {} as Record<string, boolean>,
  validationResults: { errors: 0, warnings: 0 } as ValidationResults,
  editHistory: [] as Array<Record<string, unknown>>,
  files: [] as ImportedFile[],
  cleanupSummary: null as CleanupSummary | null,
  wizardState: null as WizardState | null,
  selectedFileStem: null as string | null,
  hoveredFileStem: null as string | null,
  wizardSaveStatus: "idle" as SaveStatus,
  wizardSaveError: null as string | null,
  wizardSavedAt: null as number | null,
  wizardSaveRetry: null as (() => void) | null,
  wizardDrafts: NO_DRAFTS,
  learningSuggestion: null as LearningSuggestion | null
};

export const useAppStore = create<AppState>((set) => ({
  ...INITIAL_STATE,
  setUiLanguage: (uiLanguage) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("ui_language", uiLanguage);
    }
    set({ uiLanguage });
  },
  setTheme: (theme) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("ui_theme", theme);
    }
    set({ theme });
  },
  switchProject: (sessionId) =>
    set((state) =>
      state.sessionId === sessionId
        ? {}
        : {
            ...INITIAL_STATE,
            layerVisibility: state.layerVisibility,
            theme: state.theme,
            uiLanguage: state.uiLanguage,
            sessionId
          }
    ),
  projectLoaded: (sessionId, project) =>
    set((state) =>
      state.sessionId !== sessionId
        ? {}
        : {
            loadedSessionId: sessionId,
            importProfile: project.importProfile,
            files: project.files,
            ...(project.wizardState !== undefined ? { wizardState: project.wizardState } : {}),
            currentScreen: project.reviewReached ? "review" : "wizard"
          }
    ),
  setImportProfile: (importProfile) => set({ importProfile }),
  setSessionExpiredMessage: (sessionExpiredMessage) => set({ sessionExpiredMessage }),
  clearSession: () =>
    set((state) => ({
      ...INITIAL_STATE,
      layerVisibility: state.layerVisibility,
      // Display preferences are the operator's, not the session's: INITIAL_STATE
      // holds whatever was read at module load, so spreading it would snap the
      // theme and language back mid-session.
      theme: state.theme,
      uiLanguage: state.uiLanguage,
      currentScreen: "upload",
      sessionExpiredMessage: null
    })),
  setCurrentScreen: (currentScreen) => set({ currentScreen }),
  setIllustratorStage: (illustratorStage) => set({ illustratorStage }),
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
  setWizardSaveStatus: (wizardSaveStatus, wizardSaveError = null, wizardSaveRetry = null) =>
    set((state) => ({
      wizardSaveStatus,
      wizardSaveError,
      wizardSaveRetry,
      wizardSavedAt: wizardSaveStatus === "saved" ? Date.now() : state.wizardSavedAt
    })),
  setWizardDraft: (section, draft) =>
    set((state) => ({ wizardDrafts: { ...state.wizardDrafts, [section]: draft } })),
  setLearningSuggestion: (learningSuggestion) => set({ learningSuggestion })
}));

/**
 * Wraps a store action so it does nothing once the store holds a different
 * project: a response for the project just left must not land in the next.
 */
export function forSession<A extends unknown[]>(
  sessionId: string | null,
  action: (...args: A) => void
): (...args: A) => void {
  return (...args: A) => {
    if (useAppStore.getState().sessionId === sessionId) action(...args);
  };
}

/** A store action, from a page opened for `sessionId`, that only lands while that is still the store's project. */
export function useSessionAction<A extends unknown[]>(
  sessionId: string | null,
  pick: (state: AppState) => (...args: A) => void
): (...args: A) => void {
  const action = useAppStore(pick);
  return useMemo(() => forSession(sessionId, action), [sessionId, action]);
}
