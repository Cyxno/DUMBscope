# Releasing DUMBscope

How releases are cut, what the CI enforces, and what an operator can rely on.

## Policy

- Releases are cut from `main` by pushing an annotated tag `vMAJOR.MINOR.PATCH`
  (e.g. `v0.9.4`). Nothing else triggers a release.
- Every `fix/*`, `hardening/*` and `release-blocker/*` branch must be fully
  merged into `main` before a tag is pushed. `scripts/check-release-branches.sh`
  (the _release guard_) runs first in the release workflow and fails with the
  branch name, missing commit SHAs and subjects otherwise.
- A branch may be exempted only by listing it in
  [`.github/release-allowlist`](../.github/release-allowlist) — one branch name
  or glob per line, each active entry dated and reasoned. Malformed entries
  fail the guard; they are never silently reinterpreted.
- **Exact release tags are immutable.** The workflow refuses to publish
  `ghcr.io/cyxno/dumbscope:X.Y.Z` if that exact tag already exists. A failed or
  partial release is corrected with a _new_ version, never by re-releasing.
- `X.Y` and `latest` on GHCR are moving aliases. They are convenient
  pointers, **not** release identities — deploy production with the exact
  semantic tag (or better, the digest listed in the release manifest).

## Identity invariants (enforced per release)

For a release `vX.Y.Z` the workflow (job `validate`) proves, before anything is
built or published:

| Invariant                                                                                                       | Enforced by                            |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| tag name is strict `vX.Y.Z`                                                                                     | `scripts/validate-release-metadata.sh` |
| tag resolves to the release checkout commit                                                                     | same                                   |
| tag commit is reachable from `origin/main`                                                                      | same                                   |
| `package.json` version equals `X.Y.Z` (the runtime reports this)                                                | same                                   |
| `CHANGELOG.md` has a `## [X.Y.Z]` entry                                                                         | same                                   |
| no release-blocking branch is unmerged                                                                          | `scripts/check-release-branches.sh`    |
| lint / typecheck / unit tests / production build pass                                                           | CI gate re-run                         |
| image boots; `/api/health/live` reports version + exact tag SHA + build date; `/api/health/ready` reaches ready | release smoke test                     |

The `publish` job then pushes the multi-arch image and verifies the _published_
artifact: the exact tag and both aliases resolve to the pushed digest, the
index carries `linux/amd64` and `linux/arm64`, and a pulled container reports
the release identity. The build-provenance rule is unchanged: the image is
built with `BUILD_SHA=<tag commit>` and must report exactly that; the same
identity is applied as OCI labels (`org.opencontainers.image.revision`) so
`docker inspect` alone maps a running container back to its release commit.

This pipeline was first validated end-to-end with a real tag-triggered release
on **v0.9.7** (validate → publish → post-publish verification → manifest →
GitHub Release, all green). Post-publish registry reads retry with backoff and
fall back to a plain registry HTTP call, because `docker buildx imagetools`
intermittently fails on hosted runners with an opaque exit-255.

Each release publishes a machine-readable `release-manifest.json` (version,
tag, commit, buildDate, image, digest, generatedAt) as a GitHub release asset,
generated only from workflow-authoritative values. To answer "what exact
source produced this running image?": compare `/api/health/live` `buildSha`
with the manifest `commit`, and the manifest `digest` with
`docker inspect` / the registry.

## Drift detection (deliberately manual)

DUMBscope does not poll GitHub for newer releases — no updater, no telemetry.
To check whether a running instance lags behind the newest release, compare:

```sh
curl -fs http://<dumbscope>:8091/api/health/live | jq -r .version
git -C <repo> ls-remote --tags origin 'v*'   # or the GitHub releases page
```

## Failure handling

- Any failure in `validate` → nothing is built, nothing is published.
- Failure in `publish` after the image was pushed (post-publish verification)
  → the release is marked failed and **stays published as-is**. Do not move the
  tag; ship a new patch version with the fix.
- Re-running a failed `publish` job after a successful push fails safely on the
  immutability check (the exact tag already exists).

## Action pinning

All third-party GitHub Actions are pinned to full commit SHAs (with their
version in a trailing comment). Bump deliberately: resolve the new tag to its
commit and update the pin.
