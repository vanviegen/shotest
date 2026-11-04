#!/usr/bin/env bash
# TPS's deploy: publish this version of shotest to npm. One question to the
# user is the go-ahead: log in through npm's web login, and give the one-time
# password the publish needs. The session token goes in a throwaway npmrc, so
# the host needs no npm credentials set up.
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

log=$(mktemp)
npm login --auth-type=web </dev/null >"$log" 2>&1 &
login=$!
until url=$(grep -o 'https://www\.npmjs\.com/[^[:space:]]*' "$log"); do
    if ! kill -0 "$login" 2>/dev/null; then
        cat "$log"
        exit 1
    fi
    sleep 1
done

answer=0
reply=$(/tps/bin/tps-guest-tool ask-human \
    "To publish **shotest $version**, log in to npm, then enter a one-time password from your authenticator and press *Publish*." \
    --secret 'One-time password' \
    --button Publish --color primary --button Cancel --color neutral \
    --button 'Log in to npm' --url "$url") || answer=$?
if [ "$answer" != 0 ]; then
    kill "$login" 2>/dev/null || true
    [ "$answer" = 1 ] && echo 'Cancelled.' || echo "Asking failed (exit code $answer)."
    exit 1
fi
{ read -r _; read -r otp; } <<<"$reply"

status=0
wait "$login" || status=$?
cat "$log"
[ "$status" = 0 ]
npm publish --otp="$otp"
