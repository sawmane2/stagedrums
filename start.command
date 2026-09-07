#!/bin/bash
# macOS: double-click to start the StageDrums server and open the app.
cd "$(dirname "$0")"
(sleep 1.5; open "http://localhost:8080") &
node server.js
