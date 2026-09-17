#!/usr/bin/env bash
# Supervise the browser, Xvfb and CDP proxy together: any child exit stops all.
set -euo pipefail
CDP_PORT=${CDP_PORT:-9222}
CDP_INTERNAL_PORT=${CDP_INTERNAL_PORT:-9221}
CHROMIUM_PROFILE_DIR=${CHROMIUM_PROFILE_DIR:-/data/chrome-profile}
CHROMIUM_HEADLESS=${CHROMIUM_HEADLESS:-0}
CHROMIUM_ACCEPT_LANG=${CHROMIUM_ACCEPT_LANG:-zh-CN,zh}
for port in "$CDP_PORT" "$CDP_INTERNAL_PORT"; do
    if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
        echo 'FATAL: CDP ports must be integers between 1 and 65535' >&2; exit 1
    fi
done
if (( 10#$CDP_PORT == 10#$CDP_INTERNAL_PORT )); then
    echo 'FATAL: CDP_PORT must differ from CDP_INTERNAL_PORT' >&2; exit 1
fi
case "$CHROMIUM_HEADLESS" in 0|1) ;; *) echo 'FATAL: CHROMIUM_HEADLESS must be 0 or 1' >&2; exit 1 ;; esac
case "$CHROMIUM_PROFILE_DIR" in /*) ;; *) echo 'FATAL: profile path must be absolute' >&2; exit 1 ;; esac

binary=''
for candidate in /ms-playwright/chromium-*/chrome-linux*/chrome; do
    if [[ -x "$candidate" ]]; then binary="$candidate"; break; fi
done
if [[ -z "$binary" ]]; then echo 'FATAL: bundled Chromium executable not found' >&2; exit 1; fi

CDP_HOST=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
GATEWAY=$(ip -4 route show default | awk '/default/{print $3; exit}')
if [[ ! "$CDP_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || ! "$GATEWAY" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo 'FATAL: CDP proxy requires a bridge IPv4 address and gateway' >&2; exit 1
fi
sed "s/__CDP_HOST__/$CDP_HOST/g; s/__GATEWAY__/$GATEWAY/g; s/__CDP_PORT__/$CDP_PORT/g; s/__CDP_INTERNAL_PORT__/$CDP_INTERNAL_PORT/g" \
    /etc/nginx/cdp-proxy.conf.template > /tmp/cdp-nginx.conf
mkdir -p "$CHROMIUM_PROFILE_DIR"
chmod 700 "$CHROMIUM_PROFILE_DIR"
children=()
browser_pid=""
cleanup() {
    local status=$?
    trap - EXIT TERM INT
    if [[ -n "$browser_pid" ]] && kill -0 "$browser_pid" 2>/dev/null; then
        timeout 4 node /usr/local/lib/disclaude/close-chromium.mjs "$CDP_INTERNAL_PORT" || true
        for ((i=0; i<50; i++)); do
            kill -0 "$browser_pid" 2>/dev/null || break
            sleep .1
        done
    fi
    for child in "${children[@]}"; do kill -TERM "$child" 2>/dev/null || true; done
    # Bounded shutdown; the container init reaps grandchildren.
    sleep 1
    for child in "${children[@]}"; do kill -KILL "$child" 2>/dev/null || true; done
    wait 2>/dev/null || true
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

args=(--no-sandbox --no-first-run --no-default-browser-check
      "--remote-debugging-port=$CDP_INTERNAL_PORT" "--user-data-dir=$CHROMIUM_PROFILE_DIR"
      --window-size=1920,1080 "--accept-lang=$CHROMIUM_ACCEPT_LANG")
if [[ "$CHROMIUM_HEADLESS" == 1 ]]; then
    args+=(--headless=new)
else
    export DISPLAY=:99
    Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp & children+=("$!")
    ready=0
    for ((i=0; i<50; i++)); do
        if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
        kill -0 "${children[0]}" 2>/dev/null || break
        sleep .1
    done
    if [[ "$ready" != 1 ]]; then echo 'FATAL: Xvfb failed readiness check' >&2; exit 1; fi
fi
nginx -c /tmp/cdp-nginx.conf -g 'daemon off;' & children+=("$!")
"$binary" "${args[@]}" about:blank & browser_pid=$!; children+=("$browser_pid")
# An unexpected successful child exit is still a service failure.
status=0
wait -n "${children[@]}" || status=$?
if [[ "$status" == 0 ]]; then status=1; fi
exit "$status"
