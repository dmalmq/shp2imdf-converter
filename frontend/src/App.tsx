import { Navigate, Route, Routes } from "react-router-dom";

import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { ReviewPage } from "./pages/ReviewPage";
import { UploadPage } from "./pages/UploadPage";
import { WizardPage } from "./pages/WizardPage";


export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/wizard" element={<WizardPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}

