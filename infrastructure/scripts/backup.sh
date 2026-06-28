#!/usr/bin/env bash
# Nightly Beacon Postgres backup. Run on the VPS.
# R2 upload is DEFERRED to Phase 5: it only runs if BEACON_BACKUP_REMOTE is set.
set -euo pipefail

COMPOSE_DIR="/opt/beacon"
OUT_DIR="${BEACON_BACKUP_DIR:-/var/backups/beacon}"
STAMP="$(date +%F)"
DUMP="${OUT_DIR}/beacon-${STAMP}.sql.gz"

install -d -m 700 "$OUT_DIR"
cd "$COMPOSE_DIR"

echo "[backup] dumping -> ${DUMP}"
docker compose exec -T postgres pg_dump -U beacon beacon | gzip > "$DUMP"

if [ -n "${BEACON_BACKUP_REMOTE:-}" ]; then
  echo "[backup] uploading to ${BEACON_BACKUP_REMOTE}"
  rclone copy "$DUMP" "$BEACON_BACKUP_REMOTE"
  rm -f "$DUMP"
else
  echo "[backup] BEACON_BACKUP_REMOTE unset — local dump kept (R2 wiring is Phase 5)"
fi

echo "[backup] pruning local dumps older than 7 days"
find "$OUT_DIR" -name 'beacon-*.sql.gz' -mtime +7 -delete
