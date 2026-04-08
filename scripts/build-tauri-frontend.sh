#!/usr/bin/env bash
# Builds Next.js static export for Tauri (out/). Temporarily hides app/api so
# static export succeeds; API routes are not available in the bundled desktop app.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Cleaning previous build..."
rm -rf .next out

API_DIR="src/app/api"
API_BAK="src/app/_api_tauri_bak"
if [ -d "$API_DIR" ]; then
  echo "Temporarily moving app/api aside for static export..."
  mv "$API_DIR" "$API_BAK"
fi

echo "Building static export (TAURI_BUILD=1)..."
TAURI_BUILD=1 pnpm exec next build

if [ -d "$API_BAK" ]; then
  echo "Restoring app/api..."
  mv "$API_BAK" "$API_DIR"
fi

echo "Frontend built to out/ (ready for Tauri bundle)."
