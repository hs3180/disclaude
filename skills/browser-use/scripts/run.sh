#!/bin/sh
# Preserve Python stdin and avoid PATH changes selecting the uncoordinated CLI.
set -eu
case "${DISCLAUDE_BROWSER_RUNTIME:-}" in
  /*) browser_launcher="${DISCLAUDE_BROWSER_RUNTIME%/*}/bin/browser-use" ;;
  *) echo 'Browser runtime is unavailable: start Disclaude with the deployed Chromium CDP configured.' >&2; exit 1 ;;
esac
if [ ! -x "$browser_launcher" ]; then
  echo 'Coordinated browser launcher is missing; restart or repair Disclaude.' >&2
  exit 1
fi
exec "$browser_launcher" "$@"
