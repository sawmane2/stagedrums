#!/bin/bash
# StageDrums.app launcher. Lives at StageDrums.app/Contents/MacOS/StageDrums.
# The app bundle sits inside the drum-daw folder, so the folder is three levels up.
cd "$(dirname "$0")/../../.." || exit 1
PORT=8080
LOG="$HOME/Library/Logs/StageDrums.log"
mkdir -p "$(dirname "$LOG")"

say() { osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"StageDrums\"" >/dev/null 2>&1; }

# node is often only on the interactive PATH, so look where the installers actually put it
NODE=$(command -v node 2>/dev/null)
for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$p" ] && NODE="$p"
done
if [ -z "$NODE" ]; then
  say "StageDrums needs Node.js, and it isn't installed on this Mac. Install it from nodejs.org, then open StageDrums again."
  exit 1
fi

# already running? just bring the app up in the browser
if curl -s -m 2 "http://localhost:$PORT/api/version" >/dev/null 2>&1; then
  open "http://localhost:$PORT"
  exit 0
fi

echo "--- $(date) starting StageDrums in $(pwd)" >> "$LOG"
"$NODE" server.js "$PORT" >> "$LOG" 2>&1 &
SERVER=$!

# wait for it to answer, then open the browser
for i in $(seq 1 40); do
  sleep 0.25
  if curl -s -m 2 "http://localhost:$PORT/api/version" >/dev/null 2>&1; then
    open "http://localhost:$PORT"
    # stay alive so the app keeps its Dock icon; quitting from the Dock stops the server too
    trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
    wait $SERVER
    exit 0
  fi
  kill -0 $SERVER 2>/dev/null || break
done
say "StageDrums could not start the server. The log is at ~/Library/Logs/StageDrums.log"
exit 1
