#!/usr/bin/env bash
# SQLite backup for the hub — snapshots the live DB using `.backup` so WAL
# mode stays consistent, uploads to a Fly volume, and rotates to last 14 days.
#
# Run this via a scheduled Fly machine cron, or manually from a local shell
# with Fly wireguard. Requires: `flyctl ssh console` access to the hub app.

set -euo pipefail

APP_NAME="${FLY_APP_NAME:-nexus-hub-blazelucastaco}"
BACKUP_DIR="/data/backups"
DB_PATH="/data/hub.db"
TIMESTAMP=$(date -u +'%Y-%m-%dT%H-%M-%SZ')
OUT="${BACKUP_DIR}/hub-${TIMESTAMP}.db"
KEEP_DAYS=14

if [[ ! -f "$DB_PATH" ]]; then
  echo "no DB at $DB_PATH — are you running inside the hub container?" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# sqlite3 .backup is WAL-safe: it uses the online-backup API, not a file copy.
sqlite3 "$DB_PATH" ".backup '$OUT'"
gzip -f "$OUT"
echo "backed up to ${OUT}.gz"

# Rotate — delete anything older than $KEEP_DAYS days
find "$BACKUP_DIR" -name 'hub-*.db.gz' -type f -mtime +${KEEP_DAYS} -delete
echo "pruned backups older than $KEEP_DAYS days"

echo
echo "Local backups on volume:"
ls -lh "$BACKUP_DIR"
