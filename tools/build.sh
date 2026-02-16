#!/bin/bash
set -e

# Get the absolute path to the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Ensuring dependencies are installed (skipping scripts to avoid circular build issues)..."
(cd "$PROJECT_ROOT" && npm install --ignore-scripts)

echo "Building core package..."
(cd "$PROJECT_ROOT/packages/core" && npm run build)

echo "Building tools..."
cd "$SCRIPT_DIR"
npm install
npm run build
echo "Build complete. Tools available in tools/dist/:"
echo "  node tools/dist/gemini-history.js DIRECTORY"
echo "  node tools/dist/gemini-insights-tool-use.js DIRECTORY OUTPUT_FILE"
echo "  node tools/dist/gemini-insights-friction.js DIRECTORY OUTPUT_FILE"
