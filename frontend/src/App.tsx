import { Navigate, Route, Routes } from "react-router-dom";

import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { SessionExpiredDialog } from "./components/shared/SessionExpiredDialog";
import { ToastProvider } from "./components/shared/ToastProvider";
import { AppShell } from "./components/shell/AppShell";
import { IllustratorPage } from "./pages/IllustratorPage";
import { LegacyStageRedirect, ProjectLayout, ProjectStage } from "./pages/ProjectRoutes";
import { UploadPage } from "./pages/UploadPage";


export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <AppShell>
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/p/new" element={<Navigate to="/" replace />} />
            <Route path="/p/:sessionId" element={<ProjectLayout />}>
              <Route index element={<ProjectStage />} />
              <Route path=":stage" element={<ProjectStage />} />
            </Route>
            <Route path="/wizard" element={<LegacyStageRedirect stage="set-up" />} />
            <Route path="/review" element={<LegacyStageRedirect stage="check" />} />
            <Route path="/illustrator" element={<IllustratorPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
        <SessionExpiredDialog />
      </ErrorBoundary>
    </ToastProvider>
  );
}
