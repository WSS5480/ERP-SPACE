#!/usr/bin/env bash
# Apply every migration that has not run yet, in order, then optionally seed.
#   ./db/apply.sh            apply migrations
#   ./db/apply.sh --seed     apply migrations and load the placeholder seed
#   ./db/apply.sh --reset    drop everything first (development only)
#
# Connection comes from the standard PG* variables or DATABASE_URL.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql_args=(-v ON_ERROR_STOP=1 -q)

run() { psql "${psql_args[@]}" "$@"; }

if [[ "${1:-}" == "--reset" ]]; then
  echo "resetting schema"
  run -c "drop schema public cascade; create schema public;"
  shift
fi

run -c "create table if not exists schema_migration (
          filename   text primary key,
          applied_at timestamptz not null default now(),
          sha256     text not null
        );"

for f in "$here"/migrations/*.sql; do
  name="$(basename "$f")"
  sha="$(sha256sum "$f" | cut -d' ' -f1)"
  applied="$(run -tAc "select sha256 from schema_migration where filename = '$name'")"
  if [[ -z "$applied" ]]; then
    echo "applying $name"
    run -f "$f"
    run -c "insert into schema_migration (filename, sha256) values ('$name','$sha');"
  elif [[ "$applied" != "$sha" ]]; then
    echo "REFUSING: $name has changed since it was applied." >&2
    echo "Migrations are forward-only. Write a new one." >&2
    exit 1
  fi
done

if [[ "${1:-}" == "--seed" ]]; then
  for f in "$here"/seed/*.sql; do
    echo "seeding $(basename "$f")"
    run -f "$f"
  done
fi

echo "ok"
