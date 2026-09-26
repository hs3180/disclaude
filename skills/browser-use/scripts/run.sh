#!/bin/sh
# Keep Python on stdin; derive the host-owned launcher from the service runtime.
set -eu
if [ -n "${DISCLAUDE_BROWSER_SOCKET:-}" ]; then
  case "$DISCLAUDE_BROWSER_SOCKET" in
    /*)
      socket_dir=${DISCLAUDE_BROWSER_SOCKET%/*}
      if [ -z "$socket_dir" ]; then socket_dir=/; fi
      browser_launcher="$socket_dir/bin/browser-use"
      ;;
    *) echo 'Coordinated browser socket must be an absolute path.' >&2; exit 1 ;;
  esac
  if [ ! -x "$browser_launcher" ]; then
    echo 'Socket-relative coordinated browser launcher is missing or not executable; restart or repair the Disclaude browser service.' >&2
    exit 1
  fi
  exec "$browser_launcher" "$@"
fi
echo 'Browser coordinator is unavailable: start Disclaude with the deployed Chromium CDP service configured.' >&2
exit 1
