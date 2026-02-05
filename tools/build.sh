#!/bin/bash
set -e

# Get the absolute path to the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Building core package..."
(cd "$PROJECT_ROOT/packages/core" && npm run build)

echo "Building tools..."
cd "$SCRIPT_DIR"
npm install
npm run build
echo "Build complete. Run with: node tools/dist/gemini-history.js <directory>"
