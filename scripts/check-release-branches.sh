#!/usr/bin/env bash
# Release guard: refuse to publish a release while fix/hardening/release-blocker
# branches carry commits that never reached the baseline (origin/main).
#
# This exists because v0.9.1/v0.9.2 shipped from main without the hardening
# branch merged, which re-opened resolved incidents in production. The guard
# runs in the release workflow BEFORE anything is built or published; the
# provenance check (image must report the exact release commit) stays in place
# after it — this is additive, not a replacement.
#
# Semantics:
# - Scans remote branches matching the configured glob patterns.
# - A branch fully merged into the baseline never blocks (stale = safe).
# - A branch listed in the allowlist never blocks even when unmerged — for
#   intentionally parked experimental work (see .github/release-allowlist).
# - Anything else with baseline-unreachable commits fails with a report
#   listing branch, missing SHAs and subjects.
#
# Failure modes are fail-closed:
# - a shallow clone cannot judge ancestry → setup error (exit 2), never a pass;
# - a malformed allowlist entry (whitespace, exotic characters) is rejected
#   (exit 2) instead of being silently reinterpreted as a broader match.
#
# Configuration (environment, all optional):
#   RELEASE_GUARD_BASELINE    baseline ref          (default: origin/main)
#   RELEASE_GUARD_PATTERNS    branch globs to scan  (default: "hardening/* fix/* release-blocker/*")
#   RELEASE_GUARD_ALLOWLIST   allowlist file path   (default: .github/release-allowlist)
#
# Exit codes: 0 = pass, 1 = blocking branch found, 2 = setup error.
#
# NOTE: `set -e` is deliberately omitted — this script branches on git exit
# codes throughout (merge-base, rev-parse); `set -u` guards against unset
# variables. Pattern lists are intentionally word-split: they are only ever
# consumed by `case` as glob patterns, never eval'd or executed.
set -u

BASELINE="${RELEASE_GUARD_BASELINE:-origin/main}"
PATTERNS="${RELEASE_GUARD_PATTERNS:-hardening/* fix/* release-blocker/*}"
ALLOWLIST="${RELEASE_GUARD_ALLOWLIST:-.github/release-allowlist}"

if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
	echo "release-guard: SETUP ERROR — shallow clone cannot judge ancestry; fetch full history (actions/checkout: fetch-depth: 0)" >&2
	exit 2
fi

if ! git rev-parse --verify --quiet "${BASELINE}^{commit}" >/dev/null 2>&1; then
	echo "release-guard: SETUP ERROR — baseline '$BASELINE' not found; fetch it first (git fetch origin main)" >&2
	exit 2
fi

# Allowlist: one branch name or glob per line, '#' starts a comment. Strict:
# an entry outside [A-Za-z0-9._/*-] (e.g. containing whitespace) is rejected
# instead of being word-split into unrelated, potentially broader patterns.
IGNORE=()
if [ -f "$ALLOWLIST" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		line="${line%%#*}"
		line="${line#"${line%%[![:space:]]*}"}"
		line="${line%"${line##*[![:space:]]}"}"
		[ -n "$line" ] || continue
		case "$line" in
		*[!A-Za-z0-9._/*-]*)
			echo "release-guard: SETUP ERROR — malformed allowlist entry '$line' in $ALLOWLIST (allowed: branch names and globs over A-Z a-z 0-9 . _ / * -)" >&2
			exit 2
			;;
		esac
		IGNORE+=("$line")
	done <"$ALLOWLIST"
fi

is_ignored() {
	local branch="$1" pat
	for pat in ${IGNORE[@]+"${IGNORE[@]}"}; do
		# shellcheck disable=SC2254  # glob matching on purpose
		case "$branch" in
		$pat) return 0 ;;
		esac
	done
	return 1
}

baseline_sha="$(git rev-parse --short "$BASELINE")"
violations=0
merged=0
ignored=0
scanned=0

while IFS= read -r ref; do
	branch="${ref#origin/}"
	[ "$branch" = "HEAD" ] && continue

	matched=""
	for pat in $PATTERNS; do
		# shellcheck disable=SC2254  # glob matching on purpose
		case "$branch" in
		$pat)
			matched="$pat"
			break
			;;
		esac
	done
	[ -n "$matched" ] || continue
	scanned=$((scanned + 1))

	if ! git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null 2>&1; then
		echo "release-guard: SKIP    $branch (ref not resolvable)"
		continue
	fi

	if git merge-base --is-ancestor "$ref" "$BASELINE" >/dev/null 2>&1; then
		echo "release-guard: OK       $branch (fully merged into $BASELINE)"
		merged=$((merged + 1))
		continue
	fi

	if is_ignored "$branch"; then
		echo "release-guard: IGNORED  $branch (allowlisted as intentionally unmerged)"
		ignored=$((ignored + 1))
		continue
	fi

	if [ "$violations" -eq 0 ]; then
		echo "release-guard: FAIL — branches carrying commits not reachable from $BASELINE ($baseline_sha):"
	fi
	violations=$((violations + 1))
	echo ""
	echo "  Branch: $branch"
	git log --format='    %h  %s' "${BASELINE}..${ref}" --
	echo "    → merge this branch into main, or allowlist it in $ALLOWLIST if intentionally unmerged"
done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null)

if [ "$scanned" -eq 0 ]; then
	echo "release-guard: NOTE — no remote branches match patterns: $PATTERNS"
fi

echo "release-guard summary: scanned=$scanned merged=$merged ignored=$ignored blocking=$violations"
if [ "$violations" -gt 0 ]; then
	echo "release-guard: BLOCKED — $violations branch(es) would be regressed by this release. Nothing was published."
	exit 1
fi
echo "release-guard: PASS — all matching branches are merged or allowlisted."
exit 0
