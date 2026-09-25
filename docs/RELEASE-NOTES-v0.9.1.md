# Release Notes — v0.9.1

## fix(reliability): symlink targets behind foreign mounts are unresolvable, not broken

### Root cause (homeserver incident, 2026-09-25)

The TV/Movies symlink roots point at `/mnt/remote/nzbdav/.ids/…`, but the
usenet rclone mount lives **only inside the DUMB container**. The DUMBscope
container has no `/mnt/remote`, so every sampled symlink was ENOENT and counted
as broken (TV 23/24, Movies 20/24) — far above the systemic threshold
(≥8 samples, ≥80 % broken). The resulting warnings opened at 2026-09-24 ~18:00
and could never resolve: every probe round reproduced the same namespace
artifact. Two false mount findings accompanied them (decypharr bind stale
after a FUSE remount → ENOTCONN; nzbdav mount path absent).

### Fix

- **Namespace guard in the fsprobe worker** (`fsprobe.ts`): on ENOENT, the
  first missing directory of the target path is located. If it lies outside
  the walked tree (mount root absent in this container), the link is counted
  as **unresolvable** instead of broken. Unresolvable links are not conclusive
  evidence: they are excluded from `sampled` and can never trip the systemic
  broken-symlink finding. Existing findings resolve via the normal clean-round
  hysteresis (2 rounds).
- Evidence strings include `unresolvable=N` so an operator can see that the
  check could not judge those links in this namespace.

### Operational change

The `NZBDAV usenet mount` monitor target (`/mnt/remote/nzbdav`) is removed
from the default monitor list: that mount is not observable from the DUMBscope
container (it lives in DUMB's mount namespace), so monitoring it can only ever
produce a false finding. Its incident resolves as
"monitored mount removed from the configuration". Re-add the target only if
the mount becomes visible to this container.

### Validation

- Unit/integration suite: **454/454** (incl. new
  `tests/symlink-namespace-guard.test.ts`: unresolvable-not-broken,
  conclusive-broken-inside-tree, valid-target, engine resolve-hysteresis; and
  `mounts.test.ts` fixture moved stale targets inside the reachable tree).
- Live beta: after deploy, the three symlink/mount findings resolved
  automatically; the healthy-release sweep ran 4,398/4,398 STAT hits with the
  breaker fully transparent.

## Upgrade

```bash
docker pull ghcr.io/cyxno/dumbscope:0.9.1
# then recreate the container (Unraid: Apps/Docker tab)
```

### Rollback

Recreate the container on `ghcr.io/cyxno/dumbscope:0.9.0` and re-add the
nzbdav mount target if you want that (false-positive) monitoring back.
