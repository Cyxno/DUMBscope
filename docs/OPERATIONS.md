# Operating DUMBscope on Unraid

Upgrade and rollback procedure for the single-container deployment. DUMBscope
is one container with one `/config` volume (SQLite database + `secret.key`); no
external services.

## Upgrade checklist

1. **Record the running identity** — version, exact build SHA, image digest:
   ```sh
   curl -fs http://127.0.0.1:8091/api/health/live
   docker inspect DUMBscope --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
   ```
2. **Capture the exact container configuration** (mounts, env, ports) so the
   replacement runs with identical settings:
   ```sh
   docker inspect DUMBscope > /tmp/dumbscope-config-backup.json
   ```
3. **Take a SQLite-consistent backup** — never `cp` a live WAL database file.
   Either use the host's `sqlite3` `.backup` command for an online, consistent
   snapshot (the app keeps running; the snapshot is written next to it):
   ```sh
   sqlite3 /mnt/user/appdata/dumbscope/dumbscope.db \
     ".backup '/mnt/user/appdata/dumbscope/backups/pre-upgrade-$(date +%Y%m%d-%H%M%S).db'"
   ```
   or stop the container (step 6) and file-copy `dumbscope.db`, `-wal`, `-shm`
   and `secret.key` together — a stopped database is consistent.
4. **Pull the exact target version** — never a moving alias:
   ```sh
   docker pull ghcr.io/cyxno/dumbscope:0.9.4
   ```
5. Optionally verify provenance: the image label
   `org.opencontainers.image.revision` and later `/api/health/live` `buildSha`
   must equal the release commit; the release manifest on GitHub lists the
   expected digest.
6. **Stop the old container** (keep it around until step 13 passes):
   ```sh
   docker stop DUMBscope && docker rename DUMBscope DUMBscope-rollback
   ```
7. **Recreate with identical configuration** and the exact new tag.
8. **Verify the migration applied**: container logs print
   `database migration N applied` (or nothing when already current).
9. **Verify `/api/health/live`** → `status: live`, expected `version`, expected
   `buildSha`, `buildDate` present.
10. **Verify `/api/health/ready`** → `status: ready` (`db`, `hub`, `scheduler`
    all true). DUMB being offline does not block readiness.
11. **Verify DUMB connectivity** in the UI (System → DUMB connection) and the
    Arr/Plex integrations.
12. **Verify reconciliation + history preserved**: incidents, settings and
    activity history still present (they live in `/config`, untouched by the
    image swap).
13. **Observe a healthy state for several minutes.** Only then remove the
    rollback container/image if desired. Nothing is deleted automatically.

## Rollback

**Container-only rollback** (same `/config`, older image) is safe only while
the on-disk schema version is still supported by the older app. Migrations are
forward-only; if the newer release applied migrations, the old image either
refuses or misbehaves. Check the schema version first:

```sh
curl -fs -H "Authorization: <session>" http://127.0.0.1:8091/api/diagnostics \
  | jq .dumbscope.dbSchemaVersion
```

**Full rollback** (when the schema moved and the old version must come back):

1. Stop the failed container.
2. Restore the pre-upgrade backup made in step 3: replace `dumbscope.db`
   (and `dumbscope.db-wal` / `dumbscope.db-shm` if present) with the backup
   **while the container is stopped**, and keep `secret.key` — backups of the
   database are useless without the same key that encrypts the credentials.
3. Start the previous exact image (by tag/digest, not `latest`) with the same
   configuration.
4. Verify `/live`, `/ready`, DUMB connectivity and history as above.

Rules of thumb: backups are only ever restored against a stopped container;
`secret.key` and the database move as a pair; the rollback container/image is
removed only after the new version has proven itself.
