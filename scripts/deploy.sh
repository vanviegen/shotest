#!/usr/bin/env bash
# TPS's deploy: publish this version of shotest to npm. The user logs in
# through npm's web login, which is the go-ahead, and then confirms the
# publish with their security key on the page npm offers for it. The session
# token goes in a throwaway npmrc, so the host needs no npm credentials set up.
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
# user as a button, until it ends. npm only offers web authentication for a
# publish on a terminal, so it gets a pseudo-terminal of script's.
npm_web() {
    local question=$1 button=$2 log asked='' url pid answer
    shift 2
    log=$(mktemp)
    script -qfec "npm $* --auth-type=web --browser=false" /dev/null </dev/null >"$log" 2>&1 &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        url=$(grep -o 'https://www\.npmjs\.com/[^[:space:]]*' "$log" | tail -n 1 || true)
        if [ -n "$url" ] && [ "$url" != "$asked" ]; then
            asked=$url
            answer=0
            /tps/bin/tps-guest-tool ask-human "$question, then press *Done*." \
                --button Done --color primary --button Cancel --color neutral \
                --button "$button" --url "$url" >/dev/null || answer=$?
            if [ "$answer" != 0 ]; then
                kill "$pid" 2>/dev/null || true
                [ "$answer" = 1 ] && echo 'Cancelled.' || echo "Asking failed (exit code $answer)."
                exit 1
            fi
        fi
        sleep 1
    done
    cat "$log"
    wait "$pid"
}

npm_web "To publish **shotest $version**, log in to npm" 'Log in to npm' login
npm_web "Confirm the publish of **shotest $version** with your security key" 'Confirm on npm' publish
