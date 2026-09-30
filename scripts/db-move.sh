#!/usr/bin/env bash
# Copy the deejaytools database from one Postgres to another (the move into
# the mini-app-polis ecosystem Railway project). Run from your machine, one
# step at a time, against each database's PUBLIC connection string
# (DATABASE_PUBLIC_URL on the Railway Postgres service):
#
#   export OLD_DATABASE_URL='postgresql://...@<old>.proxy.rlwy.net:<port>/railway'
#   export NEW_DATABASE_URL='postgresql://...@<new>.proxy.rlwy.net:<port>/railway'
#
#   scripts/db-move.sh check     # read-only: versions, reachability, who is connected
#   scripts/db-move.sh dump      # read-only on OLD: pg_dump -Fc to a local file
#   scripts/db-move.sh restore   # REPLACES everything in NEW with the dump
#   scripts/db-move.sh verify    # read-only: row counts + drizzle migrations must match
#
# Needs pg_dump/pg_restore/psql at least as new as the servers (18):
#   brew install postgresql@18   (or libpq, if it is on 18)
set -euo pipefail

DUMP_DIR="${DUMP_DIR:-$HOME/deejaytools-db-move}"
SCHEMAS=(public drizzle)

die() { echo "error: $*" >&2; exit 1; }
need_url() { [ -n "${!1:-}" ] || die "$1 is not set"; }
q() { psql "$1" -XAtq -v ON_ERROR_STOP=1 -c "$2"; }
host_of() { sed -E 's#^[a-z]+://[^@]*@([^/?]+).*#\1#' <<<"$1"; }

latest_dump() { ls -1t "$DUMP_DIR"/*.dump 2>/dev/null | head -1; }

# Other client sessions on the database — the old API still running shows up
# here, and anything it writes after the dump is lost.
other_clients() {
  q "$1" "select count(*) from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and backend_type = 'client backend'"
}

row_counts() {
  local url=$1 schemas_sql
  schemas_sql=$(printf "'%s'," "${SCHEMAS[@]}"); schemas_sql=${schemas_sql%,}
  q "$url" "select table_schema || '.' || table_name from information_schema.tables
            where table_schema in ($schemas_sql) and table_type = 'BASE TABLE'
            order by 1" |
    while read -r t; do
      printf '%s %s\n' "$t" "$(q "$url" "select count(*) from $t")"
    done
}

cmd_check() {
  need_url OLD_DATABASE_URL; need_url NEW_DATABASE_URL
  local tool_major
  tool_major=$(pg_dump --version | grep -Eo '[0-9]+' | head -1)
  echo "pg_dump client major: $tool_major"
  for name in OLD_DATABASE_URL NEW_DATABASE_URL; do
    local url=${!name} ver major
    ver=$(q "$url" "show server_version_num") || die "$name ($(host_of "$url")) is unreachable"
    major=$((ver / 10000))
    echo "$name  $(host_of "$url")  server $major  other clients: $(other_clients "$url")"
    [ "$tool_major" -ge "$major" ] || die "pg_dump $tool_major is older than server $major"
    echo "  migrations applied: $(q "$url" "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo none)"
  done
}

cmd_dump() {
  need_url OLD_DATABASE_URL
  local n
  n=$(other_clients "$OLD_DATABASE_URL")
  if [ "$n" != 0 ]; then
    echo "WARNING: $n other client(s) are connected to OLD. If the old API is still running,"
    echo "anything it writes after this dump is lost. Stop it first."
    read -r -p "Dump anyway? [y/N] " ok; [ "$ok" = y ] || exit 1
  fi
  mkdir -p "$DUMP_DIR"
  local out
  out="$DUMP_DIR/deejaytools-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump -Fc --no-owner --no-acl -f "$out" "$OLD_DATABASE_URL"
  row_counts "$OLD_DATABASE_URL" > "$out.counts"
  echo "wrote $out ($(du -h "$out" | cut -f1)) and $out.counts"
}

cmd_restore() {
  need_url NEW_DATABASE_URL
  local dump
  dump=$(latest_dump) || true
  [ -n "$dump" ] || die "no dump in $DUMP_DIR — run dump first"
  echo "Restore $dump"
  echo "   into $(host_of "$NEW_DATABASE_URL")"
  echo "Everything in the dump is dropped and recreated in NEW (the new API's first"
  echo "deploy already ran migrations there, so its empty tables get replaced)."
  [ "$(host_of "$NEW_DATABASE_URL")" != "$(host_of "${OLD_DATABASE_URL:-}")" ] ||
    die "NEW and OLD are the same host"
  read -r -p "Type the NEW host to continue: " typed
  [ "$typed" = "$(host_of "$NEW_DATABASE_URL")" ] || die "host did not match; nothing changed"
  # One transaction: a failure leaves NEW exactly as it was.
  pg_restore --clean --if-exists --no-owner --no-acl --single-transaction \
    --exit-on-error -d "$NEW_DATABASE_URL" "$dump"
  echo "restored. now run: $0 verify"
}

cmd_verify() {
  need_url NEW_DATABASE_URL
  local dump expected actual
  dump=$(latest_dump) || true
  [ -n "$dump" ] && [ -f "$dump.counts" ] || die "no dump counts in $DUMP_DIR"
  expected="$dump.counts"
  actual=$(mktemp)
  row_counts "$NEW_DATABASE_URL" > "$actual"
  if diff -u --label "OLD at dump" --label "NEW now" "$expected" "$actual"; then
    echo "OK: $(wc -l < "$expected" | tr -d ' ') tables match, including drizzle.__drizzle_migrations"
  else
    die "row counts differ (above)"
  fi
  echo "latest migration in NEW: $(q "$NEW_DATABASE_URL" \
    "select hash from drizzle.__drizzle_migrations order by created_at desc limit 1")"
}

case "${1:-}" in
  check) cmd_check ;;
  dump) cmd_dump ;;
  restore) cmd_restore ;;
  verify) cmd_verify ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
