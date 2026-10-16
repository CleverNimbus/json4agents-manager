#!/usr/bin/env bash
# Static local server for the JSON Manager web app.
# No backend, no build step. Serve the directory and open in a browser.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "Serving JSON Manager at http://localhost:${PORT}"
echo "Open http://localhost:${PORT} in Chrome or Edge (File System Access API)."
python3 -m http.server "${PORT}"
