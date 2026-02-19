import { Navigate, Route, Routes } from "react-router-dom";

import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { SessionExpiredDialog } from "./components/shared/SessionExpiredDialog";
import { ToastProvider } from "./components/shared/ToastProvider";
import { ReviewPage } from "./pages/ReviewPage";
import { UploadPage } from "./pages/UploadPage";
import { WizardPage } from "./pages/WizardPage";


export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<UploadPage />} />
          <Route path="/wizard" element={<WizardPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <SessionExpiredDialog />
      </ErrorBoundary>
    </ToastProvider>
  );
}
