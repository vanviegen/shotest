#!/usr/bin/env bash
# TPS's deploy: publish this version of shotest to npm. Logging in through
# npm's web login is the go-ahead; its session token goes in a throwaway
# npmrc, so the host needs no npm credentials set up.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p 'require("./package.json").version')
if [ "$(npm view shotest version)" = "$version" ]; then
    echo "shotest $version is on npm already; nothing to publish."
    exit 0
fi

npm install --no-package-lock --no-audit --no-fund
NPM_CONFIG_USERCONFIG=$(mktemp)
export NPM_CONFIG_USERCONFIG

# Run an npm command, handing each web authentication URL it prints to the
# user, until it ends.
npm_web() {
    local question=$1 log asked='' url pid
    shift
    log=$(mktemp)
    npm "$@" --auth-type=web </dev/null >"$log" 2>&1 &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        url=$(grep -o 'https://www\.npmjs\.com/[^[:space:]]*' "$log" | tail -n 1 || true)
        if [ -n "$url" ] && [ "$url" != "$asked" ]; then
            asked=$url
            local answer=0
            /tps/bin/tps-guest-tool ask-human "$question $url" --option Done --option Cancel >/dev/null || answer=$?
            if [ "$answer" != 0 ]; then
                kill "$pid"
                [ "$answer" = 1 ] && echo 'Cancelled.' || echo "Asking failed (exit code $answer)."
                exit 1
            fi
        fi
        sleep 1
    done
    cat "$log"
    wait "$pid"
}

npm_web "To publish shotest $version, log in to npm at" login
npm_web "npm wants the publish of shotest $version confirmed at" publish
