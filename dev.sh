#!/usr/bin/env bash
# Start backend (FastAPI) and frontend (Vite) dev servers together.
# Ctrl+C stops both.
set -e

cd "$(dirname "$0")"

uvicorn backend.main:app --reload --port 8310 &
BACKEND_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

trap 'kill $BACKEND_PID $FRONTEND_PID 2>/dev/null' EXIT INT TERM

wait
