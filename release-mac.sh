#!/bin/sh
# Build both macOS .dmg architectures, notarize them, and attach them to the draft
# GitHub Release that CI already opened for a tag (Windows/Linux come from
# .github/workflows/release.yml; macOS can't join that job — the Developer ID
# signing certificate lives only in the local keychain on this machine, and Mac
# runners cost 10x anyway. See README.md / CLAUDE.md / AGENTS.md).
#
# Usage:
#   ./release-mac.sh v6.0.0
#
# Prerequisites (one-time): gh CLI installed and authenticated, and notarization
# credentials stored under the profile name below (see README.md's
# "Building the desktop app" section for the xcrun notarytool store-credentials
# command).
#
# POSIX sh + set -eu, same style as start.sh / desk.sh.

set -eu

cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

TAG="${1:-}"
[ -n "$TAG" ] || die "Usage: ./release-mac.sh <tag>

Example: ./release-mac.sh v6.0.0"

command -v gh >/dev/null 2>&1 || die "gh CLI not found. Install it: brew install gh"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

# This script attaches macOS artifacts to a release CI already opened. It never
# creates one — creating it here would let a local run publish a release CI hasn't
# built Windows/Linux installers for yet.
gh release view "$TAG" >/dev/null 2>&1 || die "No release found for tag '$TAG'.
Push the tag first and wait for CI to open the draft release:

  git tag $TAG && git push origin $TAG

Then watch it at: gh run watch"

APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-smarti}"
export APPLE_KEYCHAIN_PROFILE

cd desktop
rm -rf dist

say "Building arm64 (notarized)..."
npm run dist:mac:notarized

say "Building x64 (notarized)..."
npm run dist:mac:intel:notarized

VERSION=$(node -p "require('./package.json').version")
ARM_DMG="dist/SmartiBoard-${VERSION}-mac-arm64.dmg"
INTEL_DMG="dist/SmartiBoard-${VERSION}-mac-x64.dmg"

for dmg in "$ARM_DMG" "$INTEL_DMG"; do
  [ -f "$dmg" ] || die "Expected build output missing: $dmg"
  say "Verifying notarization: $dmg"
  spctl -a -t open --context context:primary-signature -v "$dmg" \
    || die "$dmg is not notarized (or notarization could not be verified).
electron-builder logs 'skipped macOS notarization' when APPLE_KEYCHAIN_PROFILE
isn't picked up — check that credentials are stored under the profile
'$APPLE_KEYCHAIN_PROFILE' (see README.md's notarytool store-credentials step)."
done

say "Uploading to release $TAG..."
gh release upload "$TAG" "$ARM_DMG" "$INTEL_DMG" --clobber

say ""
say "Done. Release assets:"
gh release view "$TAG" --json assets
