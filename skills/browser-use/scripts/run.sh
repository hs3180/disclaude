#!/bin/sh
# Keep Python on stdin; select the host-owned launcher without PATH lookup.
set -eu
if [ -n "${DISCLAUDE_BROWSER_SOCKET:-}" ]; then
  case "${DISCLAUDE_BROWSER_BIN:-}" in
    /*) browser_launcher="$DISCLAUDE_BROWSER_BIN/browser-use" ;;
    *) echo 'Coordinated browser launcher missing: configure an absolute DISCLAUDE_BROWSER_BIN in the service environment.' >&2; exit 1 ;;
  esac
  if [ ! -x "$browser_launcher" ]; then
    echo 'Configured coordinated browser launcher is not executable; repair the service browser configuration.' >&2
    exit 1
  fi
  exec "$browser_launcher" "$@"
fi
exec browser-use "$@"
