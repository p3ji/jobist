#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to run Jobist locally."
  read -k 1 '?Press any key to close this window...'
  exit 1
fi

if /usr/bin/curl -fsS http://127.0.0.1:8080/ 2>/dev/null | /usr/bin/grep -q 'Jobist'; then
  open http://localhost:8080/
  exit 0
fi

python3 server.py &
jobist_pid=$!
trap 'kill "$jobist_pid" 2>/dev/null || true' EXIT INT TERM
sleep 1
if ! kill -0 "$jobist_pid" 2>/dev/null; then
  echo "Jobist could not start. Port 8080 may already be in use."
  read -k 1 '?Press any key to close this window...'
  exit 1
fi

open http://localhost:8080/
echo "Jobist is running. Keep this window open while using local AI."
wait "$jobist_pid"
