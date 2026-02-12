#!/bin/bash
set -e

# Get the absolute path to the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Building core package..."
if ! (cd "$PROJECT_ROOT/packages/core" && npm run build); then
  echo "Build failed. Attempting to fix by installing dependencies in project root..."
  (cd "$PROJECT_ROOT" && npm install)

  echo "Retrying core package build..."
  (cd "$PROJECT_ROOT/packages/core" && npm run build)
fi

echo "Building tools..."
cd "$SCRIPT_DIR"
npm install
npm run build
echo "Build complete. Tools available in tools/dist/:"
echo "  node tools/dist/gemini-history.js <directory>"
echo "  node tools/dist/gemini-insights-tool-use.js <directory>"
