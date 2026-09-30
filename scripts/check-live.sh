#!/usr/bin/env bash
# Is everything connected? Run after the move (and any time) against one
# environment. Read-only: it only makes GET and OPTIONS requests.
#
#   scripts/check-live.sh dev          # api-dev.deejaytools.com + dev.deejaytools.com
#   scripts/check-live.sh production   # api.deejaytools.com + deejaytools.com
#
# With the old service stopped, a healthy answer on the custom domain can
# only come from the new one.
set -uo pipefail

case "${1:-}" in
  dev) API=https://api-dev.deejaytools.com; SITE=https://dev.deejaytools.com ;;
  production) API=https://api.deejaytools.com; SITE=https://deejaytools.com ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac

failures=0
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "API  $API"
host=${API#https://}
target=$(dig +short CNAME "$host" 2>/dev/null | grep -v '^;' | head -1)
[ -n "$target" ] && ok "DNS $host -> $target" || bad "DNS: no CNAME for $host"

code=$(curl -sS -o "$tmp/health" -w '%{http_code}' --max-time 10 "$API/health" 2>"$tmp/err")
if [ "$code" = 200 ] && grep -q '"ok"' "$tmp/health"; then
  ok "TLS + /health 200 (database reachable)"
else
  bad "/health answered ${code:-nothing}: $(cat "$tmp/health" "$tmp/err" 2>/dev/null | head -c 200)"
fi

code=$(curl -sS -o "$tmp/me" -w '%{http_code}' --max-time 10 "$API/v1/auth/me")
if [ "$code" = 401 ] && grep -q '"error"' "$tmp/me"; then
  ok "/v1/auth/me without a token -> 401 envelope (app up, auth wired)"
else
  bad "/v1/auth/me without a token answered $code, not 401"
fi

allow=$(curl -sS -o /dev/null -D - --max-time 10 -X OPTIONS "$API/v1/auth/me" \
  -H "Origin: $SITE" -H 'Access-Control-Request-Method: GET' |
  tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
[ "$allow" = "$SITE" ] && ok "CORS allows $SITE" || bad "CORS: allow-origin is '${allow:-missing}', not $SITE"

echo "SITE $SITE"
code=$(curl -sS -o "$tmp/index.html" -w '%{http_code}' --max-time 10 "$SITE/")
[ "$code" = 200 ] && ok "site 200" || bad "site answered $code"
asset=$(grep -Eo '/assets/index-[A-Za-z0-9_-]+\.js' "$tmp/index.html" | head -1)
if [ -n "$asset" ] && curl -sS --max-time 10 -o "$tmp/app.js" "$SITE$asset"; then
  grep -q 'down for maintenance' "$tmp/app.js" &&
    bad "site is still in maintenance mode (unset VITE_MAINTENANCE and redeploy)" ||
    ok "site is out of maintenance mode"
  grep -qF "$API" "$tmp/app.js" && ok "site calls $API" ||
    bad "site bundle does not contain $API (check VITE_API_URL)"
else
  bad "could not fetch the site's app bundle"
fi

echo
if [ "$failures" = 0 ]; then
  echo "All connected. By hand: 'scheduler_started' in the new service's logs, and sign in on $SITE."
else
  echo "$failures check(s) failed."; exit 1
fi
