#!/bin/sh
# Preserve Python stdin and avoid PATH changes selecting the uncoordinated CLI.
set -eu
# #5601: on failure print the same-source diagnosis that backs
# `disclaude browser status --json`, plus one recovery line.
report_diagnosis() {
  if command -v disclaude >/dev/null 2>&1; then
    disclaude browser status --json >&2 2>/dev/null || true
  fi
  echo 'Recovery: start or restart Disclaude with the Chromium CDP endpoint configured; disclaude browser status --json reports the endpoint, its source and the failure cause.' >&2
}
case "${DISCLAUDE_BROWSER_RUNTIME:-}" in
  /*) browser_launcher="${DISCLAUDE_BROWSER_RUNTIME%/*}/bin/browser-use" ;;
  *)
    echo 'Browser runtime is unavailable: start Disclaude with the deployed Chromium CDP configured.' >&2
    report_diagnosis
    exit 1
    ;;
esac
if [ ! -x "$browser_launcher" ]; then
  echo 'Coordinated browser launcher is missing; restart or repair Disclaude.' >&2
  report_diagnosis
  exit 1
fi
exec "$browser_launcher" "$@"
