#!/bin/zsh
cd "$(dirname "$0")" || exit 1
PORT=4180
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT+1))
done
echo "mediapipe 1.0  →  http://127.0.0.1:$PORT/"
python3 -m http.server "$PORT" &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:$PORT/"
wait $SERVER_PID
