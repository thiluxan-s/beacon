#!/usr/bin/env bash
# Beacon production deploy. Run on the VPS from /opt/beacon.
# Usage: deploy.sh <git-sha>
set -euo pipefail

NEW_VERSION="${1:?usage: deploy.sh <git-sha>}"
COMPOSE_DIR="/opt/beacon"
VERSION_FILE="${COMPOSE_DIR}/.deployed_version"
WEB_HEALTH="https://beacon.thiluxan.com/health"
API_HEALTH="https://api.beacon.thiluxan.com/health"

cd "$COMPOSE_DIR"

PREVIOUS_VERSION=""
[ -f "$VERSION_FILE" ] && PREVIOUS_VERSION="$(cat "$VERSION_FILE")"

export BEACON_VERSION="$NEW_VERSION"
# POSTGRES_PASSWORD is sourced from the env file used by compose interpolation.
set -a
# shellcheck source=/dev/null
. "${COMPOSE_DIR}/.env"
set +a

if [ -z "${INTEGRATIONS_ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: INTEGRATIONS_ENCRYPTION_KEY is not set in /opt/beacon/.env — add it before deploying (openssl rand -base64 32)" >&2
  exit 1
fi

echo "[deploy] pulling images @ ${NEW_VERSION}"
docker compose pull web server

echo "[deploy] running migrations"
if ! docker compose run --rm server npm run db:migrate; then
  echo "[deploy] migration FAILED — aborting before traffic flip" >&2
  exit 1
fi

echo "[deploy] bringing stack up"
docker compose up -d

verify() {
  local url="$1"
  for _ in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then return 0; fi
    sleep 2
  done
  return 1
}

echo "[deploy] verifying health"
if verify "$API_HEALTH" && verify "$WEB_HEALTH"; then
  echo "$NEW_VERSION" > "$VERSION_FILE"
  echo "[deploy] OK @ ${NEW_VERSION}"
  exit 0
fi

echo "[deploy] health check FAILED" >&2
# NOTE: this rolls back the IMAGES only — the database migration above is not reverted
# (we run forward-only migrations, by design). Keep every migration backward-compatible
# so the previous image can run against the already-migrated schema. If a migration is
# ever non-additive, an image rollback alone will NOT restore a working state.
if [ -n "$PREVIOUS_VERSION" ]; then
  echo "[deploy] rolling back IMAGES to ${PREVIOUS_VERSION} (schema NOT reverted)" >&2
  export BEACON_VERSION="$PREVIOUS_VERSION"
  docker compose pull web server
  docker compose up -d
fi
exit 1
