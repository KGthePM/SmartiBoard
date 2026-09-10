#!/bin/sh
# Launch the Electron desktop shell for local testing (the `desk.sh` wrapper).
#
# Why this exists: `cd desktop && npm run dev` under a stock system Node (18 on
# Debian/Ubuntu) dies inside Electron's install script with ERR_REQUIRE_ESM —
# Electron 42 needs Node 22+. start.sh already fetches a pinned Node into ./.node;
# this reuses it for the desktop path, so testing the shell never depends on what
# node happens to be on PATH.
#
# Usage:
#   ./desk.sh          stage + launch the Electron window (npm run dev)
#   ./desk.sh dist     build the Linux installers into desktop/dist/
#
# POSIX sh on purpose, same as start.sh: it runs before we control the environment.

set -eu

cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

# Prefer the repo's own Node; fall back to the system one only if it is 22+.
if [ -x ".node/bin/node" ]; then
  PATH="$PWD/.node/bin:$PATH"
  export PATH
elif ! node -e 'const v=+process.versions.node.split(".")[0];process.exit(v>=22&&v<27?0:1)' 2>/dev/null; then
  die "No usable Node found. Run ./start.sh once first — it fetches Node 24 into ./.node — then retry ./desk.sh"
fi

say "node $(node --version) — $(command -v node)"

cd desktop

case "${1:-dev}" in
  dev)
    say "staging and launching the desktop shell..."
    exec npm run dev
    ;;
  dist)
    say "building Linux installers into desktop/dist/ ..."
    exec npm run dist:linux
    ;;
  *)
    die "Unknown option: $1 (expected: nothing, or 'dist')"
    ;;
esac
