#!/usr/bin/env bash
# Release metadata validation: one release must have one unambiguous identity.
#
# Verifies, before anything is built or published:
# - the tag name is a strict semantic version (vMAJOR.MINOR.PATCH),
# - the tag exists and resolves to exactly the checked-out commit,
# - that commit is reachable from the mainline (releases are cut from main),
# - package.json's version equals the tag version (the runtime reports this
#   version via vite define, so this ties /api/health/live to the tag),
# - CHANGELOG.md carries a "## [VERSION]" entry for the release.
#
# Complements (never replaces) the provenance check, which proves the IMAGE
# was built from the tagged commit; this script proves the TAG, VERSION and
# CHANGELOG agree before the build even starts.
#
# Configuration (environment, all optional):
#   RELEASE_TAG        tag to validate   (default: GITHUB_REF_NAME)
#   RELEASE_MAIN_REF   mainline ref      (default: origin/main)
#
# Exit codes: 0 = consistent, 1 = identity mismatch, 2 = setup error.
#
# NOTE: `set -e` deliberately omitted (branching on git exit codes); `set -u`
# guards unset variables.
set -u

TAG="${RELEASE_TAG:-${GITHUB_REF_NAME:-}}"
MAIN_REF="${RELEASE_MAIN_REF:-origin/main}"

if [ -z "$TAG" ]; then
	echo "release-metadata: SETUP ERROR — no tag to validate (set RELEASE_TAG or GITHUB_REF_NAME)" >&2
	exit 2
fi

if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
	echo "release-metadata: SETUP ERROR — shallow clone cannot judge ancestry; fetch full history (actions/checkout: fetch-depth: 0)" >&2
	exit 2
fi

fail() {
	echo "release-metadata: FAIL — $1" >&2
	exit 1
}

# 1. Tag name must be a strict semantic version.
case "$TAG" in
v[0-9]*.[0-9]*.[0-9]*) : ;;
*)
	fail "tag '$TAG' is not a semantic release tag (expected vMAJOR.MINOR.PATCH)"
	;;
esac
VERSION="${TAG#v}"

# 2. The tag must exist and resolve to a commit.
if ! git rev-parse --verify --quiet "${TAG}^{commit}" >/dev/null 2>&1; then
	echo "release-metadata: SETUP ERROR — tag '$TAG' does not resolve to a commit" >&2
	exit 2
fi
tag_target="$(git rev-list -n1 "$TAG")"

# 3. The tag must point at exactly the commit being released (the workflow
# checkout is a detached HEAD at the tag).
head_commit="$(git rev-parse HEAD)"
if [ "$tag_target" != "$head_commit" ]; then
	fail "tag '$TAG' points at $tag_target but the release checkout is $head_commit"
fi

# 4. Releases are cut from main: the tag commit must be reachable from the
# mainline ref. A tag cut from a side branch or an old commit fails here.
if ! git rev-parse --verify --quiet "${MAIN_REF}^{commit}" >/dev/null 2>&1; then
	echo "release-metadata: SETUP ERROR — mainline '$MAIN_REF' not found; fetch it first (git fetch origin main)" >&2
	exit 2
fi
if ! git merge-base --is-ancestor "$tag_target" "$MAIN_REF" >/dev/null 2>&1; then
	fail "tag '$TAG' ($tag_target) is not reachable from $MAIN_REF — releases are cut from main"
fi

# 5. package.json version must equal the tag version: the app reports this
# version at runtime (vite define __APP_VERSION__ ← package.json).
if [ ! -f package.json ]; then
	echo "release-metadata: SETUP ERROR — package.json not found (run from the repository root)" >&2
	exit 2
fi
pkg_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
if [ -z "$pkg_version" ]; then
	fail "package.json has no version field"
fi
if [ "$pkg_version" != "$VERSION" ]; then
	fail "package.json version '$pkg_version' != tag version '$VERSION' — the runtime would report a version that does not match the image tag"
fi

# 6. The changelog must have an entry for this version.
if [ ! -f CHANGELOG.md ]; then
	fail "CHANGELOG.md not found"
fi
if ! grep -Eq "^## \[$VERSION\]" CHANGELOG.md; then
	fail "CHANGELOG.md has no '## [$VERSION]' entry — document the release before tagging"
fi

main_sha="$(git rev-parse --short "$MAIN_REF")"
echo "release-metadata: tag=$TAG version=$VERSION commit=$tag_target main=$MAIN_REF ($main_sha) changelog=ok"
echo "release-metadata: PASS — release identity is consistent."
exit 0
