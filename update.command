#!/bin/bash
# macOS: double-click to update StageDrums to the latest version on GitHub.
cd "$(dirname "$0")"
node server.js --update
read -n 1 -s -r -p "Press any key to close"
