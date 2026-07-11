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

# Apply Caddyfile changes. The Caddyfile is a SINGLE-FILE bind mount
# (./Caddyfile:/etc/caddy/Caddyfile). CI's scp replaces that file atomically
# (write-temp + rename → a NEW inode), which the running caddy container does
# NOT see — it still holds the old inode — so `caddy reload` would re-read the
# stale in-container copy and silently apply nothing. The container must be
# RECREATED to re-resolve the bind mount to the current file. Validate the new
# config in a throwaway container first (a fresh container mounts the current
# inode; the running one does not); on failure we skip the recreate and leave
# caddy serving its previous config. Best-effort — a caddy hiccup must never
# fail an otherwise-healthy app deploy.
echo "[deploy] applying caddy config (recreate to pick up the synced Caddyfile)"
if docker compose run --rm --no-deps --entrypoint caddy -T caddy validate --config /etc/caddy/Caddyfile; then
  if docker compose up -d --force-recreate --no-deps caddy; then
    echo "[deploy] caddy recreated with current config"
  else
    echo "[deploy] WARN: caddy recreate failed — check the proxy" >&2
  fi
else
  echo "[deploy] WARN: Caddyfile validate failed — skipping recreate, caddy left on previous config" >&2
fi

verify() {
  local url="$1"
  for _ in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then return 0; fi
    sleep 2
  done
  return 1
}

# Keep only the current and previous version of each app image so the disk does
# not fill with old deploy tags (a full disk broke a deploy once — "no space left
# on device" while extracting a layer). The previous version is deliberately kept:
# the rollback path below re-pulls it, and those images are not attached to a
# running container, so a blanket `docker image prune -af` would delete them and
# break rollback. Runs only after a health-verified deploy; never fails the deploy.
prune_old_images() {
  local keep_new="$1" keep_prev="$2"
  for repo in ghcr.io/thiluxan-s/beacon-web ghcr.io/thiluxan-s/beacon-server; do
    docker images "$repo" --format '{{.Repository}}:{{.Tag}} {{.Tag}}' | while read -r ref tag; do
      [ "$tag" = "<none>" ] && continue
      [ "$tag" = "$keep_new" ] && continue
      [ -n "$keep_prev" ] && [ "$tag" = "$keep_prev" ] && continue
      docker rmi "$ref" >/dev/null 2>&1 || true
    done
  done
  docker image prune -f >/dev/null 2>&1 || true   # dangling layers only — never a tagged version
}

echo "[deploy] verifying health"
if verify "$API_HEALTH" && verify "$WEB_HEALTH"; then
  echo "$NEW_VERSION" > "$VERSION_FILE"
  echo "[deploy] pruning old images (keeping ${NEW_VERSION}${PREVIOUS_VERSION:+, ${PREVIOUS_VERSION}})"
  prune_old_images "$NEW_VERSION" "$PREVIOUS_VERSION" || true
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
