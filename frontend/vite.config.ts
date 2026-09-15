import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports are deliberately off the framework defaults: this machine also runs
// other projects, and Vite's 5173 collides with any other Vite app while
// FastAPI's 8000 collides with any other uvicorn. Keep the two in step — the
// proxy target must match the port `dev.ps1` / `dev.sh` pass to uvicorn.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") }
  },
  server: {
    port: 5310,
    strictPort: true, // fail loudly on a clash instead of silently sliding to 5311
    proxy: {
      "/api": "http://localhost:8310"
    }
  },
  // `vite preview` serves the production build; give it the same backend proxy so
  // a built bundle can be smoke-tested against the local API. Off the dev port so
  // it never fights the running dev server.
  preview: {
    port: 5320,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8310"
    }
  }
});
