import { Navigate, Route, Routes } from "react-router-dom";

import { TileBuildNotice, TileBuildProvider } from "./components/colorTheme/TileBuildMonitor";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { SessionExpiredDialog } from "./components/shared/SessionExpiredDialog";
import { ToastProvider } from "./components/shared/ToastProvider";
import { AppShell } from "./components/shell/AppShell";
import { COLOR_THEME_PATH } from "./components/shell/stages";
import { ArtworkRoute } from "./pages/ArtworkRoute";
import { ColorThemePage } from "./pages/ColorThemePage";
import { HubPage } from "./pages/HubPage";
import { LegacyStageRedirect, ProjectLayout, ProjectStage, SplitStage } from "./pages/ProjectRoutes";
import { TileViewerPage } from "./pages/TileViewerPage";
import { UploadPage } from "./pages/UploadPage";

export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <TileBuildProvider>
          <AppShell>
            <TileBuildNotice />
            <Routes>
              <Route path="/" element={<HubPage />} />
              <Route path="/p/new" element={<UploadPage />} />
              <Route path="/p/:sessionId" element={<ProjectLayout />}>
                <Route index element={<ProjectStage />} />
                <Route path=":stage" element={<ProjectStage />} />
                <Route path="bring-in/split" element={<SplitStage />} />
              </Route>
              <Route path="/wizard" element={<LegacyStageRedirect stage="set-up" />} />
              <Route path="/review" element={<LegacyStageRedirect stage="check" />} />
              <Route path="/illustrator" element={<ArtworkRoute />} />
              <Route path="/a/:conversionId" element={<ArtworkRoute />} />
              <Route path={COLOR_THEME_PATH} element={<ColorThemePage />} />
              <Route path={`${COLOR_THEME_PATH}/tiles/:jobId?`} element={<TileViewerPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
        </TileBuildProvider>
        <SessionExpiredDialog />
      </ErrorBoundary>
    </ToastProvider>
  );
}
