import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { DroppedFiles } from "../lib/hub";

/**
 * The files the hub's drop zone handed over, read once. The history entry is
 * then replaced without them, so a reload or a Back onto this page does not
 * hand them over again.
 */
export function useDroppedFiles(): File[] {
  const location = useLocation();
  const navigate = useNavigate();
  const [files] = useState(() => (location.state as DroppedFiles | null)?.droppedFiles ?? []);

  useEffect(() => {
    if (files.length > 0) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, []);

  return files;
}
