#!/bin/sh
# Clone-and-run entry point.
#
# Debian and Ubuntu ship Node 18. better-sqlite3 needs 22+ to install without a C++
# toolchain, so on a stock box `npm install` cannot work. Rather than make that the
# user's problem, this fetches a private Node into ./.node and uses it — the gradlew
# pattern. Nothing outside this directory is touched, no sudo, no system Node replaced.
#
# POSIX sh on purpose: it runs before we have any control over the environment.

set -eu

# Everything downstream is relative to the repo: SMARTI_DB_PATH defaults to
# ./data/smarti.db, so being invoked from elsewhere would otherwise silently create a
# second, empty database.
cd "$(dirname "$0")"

NODE_VERSION="24.20.0"
NODE_DIR=".node"
MIN_MAJOR=22
MAX_MAJOR=26

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

# Reaching this app over the network is opt-in, once per run, and never the default.
# There is no login, no session, and no per-user anything: every /api route answers
# whoever asks. Binding to the LAN is therefore a decision about the room you are in,
# which is the operator's to make each time and not something the app should assume.
# Nothing about the choice is stored — it belongs to the invocation, not the install.
#
# It is a real binding, not a banner: `next dev` on its own listens on every interface,
# so the npm scripts pin -H to $SMARTI_HOST, defaulting to 127.0.0.1. This flag is the
# only thing that widens it, and `npm run dev` by hand is loopback-only too.
LAN="${SMARTI_LAN:-}"
case "${1:-}" in
  --lan) LAN=1 ;;
  "") ;;
  *) die "Unknown option: $1
Usage: ./start.sh [--lan]

  --lan    also serve to other devices on this network (see README)" ;;
esac

# Echoes the major version of the given node binary, or nothing if unusable.
node_major() {
  "$1" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || true
}

supported() {
  [ -n "$1" ] && [ "$1" -ge "$MIN_MAJOR" ] 2>/dev/null && [ "$1" -le "$MAX_MAJOR" ] 2>/dev/null
}

bootstrap_node() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Linux)  plat="linux" ;;
    Darwin) plat="darwin" ;;
    *) die "Unsupported OS: $os
On Windows, run this from WSL, or install Node ${MIN_MAJOR}+ and use: npm install && npm run dev" ;;
  esac

  case "$arch" in
    x86_64|amd64) cpu="x64" ;;
    aarch64|arm64) cpu="arm64" ;;
    *) die "Unsupported CPU: $arch
Install Node ${MIN_MAJOR}+ yourself, then: npm install && npm run dev" ;;
  esac

  # nodejs.org builds link against glibc. Alpine and other musl distros need the
  # unofficial musl builds, which is a different URL and not worth guessing at.
  if [ "$plat" = "linux" ] && [ -f /etc/alpine-release ]; then
    die "Alpine/musl needs a different Node build than nodejs.org publishes here.
Install it with: apk add nodejs npm   (Node ${MIN_MAJOR}+), then: npm install && npm run dev"
  fi

  command -v curl >/dev/null 2>&1 || die "curl is required to download Node. Install it, or install Node ${MIN_MAJOR}+ yourself."
  command -v tar  >/dev/null 2>&1 || die "tar is required to unpack Node. Install it, or install Node ${MIN_MAJOR}+ yourself."

  name="node-v${NODE_VERSION}-${plat}-${cpu}"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz"
  tmp=".node-tmp"

  say "No suitable Node found. Downloading Node ${NODE_VERSION} (${plat}-${cpu}, ~30 MB)..."
  say "It goes in ./${NODE_DIR} — nothing outside this folder is modified."

  rm -rf "$tmp"
  mkdir -p "$tmp"
  curl -fsSL --retry 3 -o "$tmp/${name}.tar.xz" "$url" \
    || die "Download failed: $url"

  # A truncated or tampered toolchain fails in ways that are miserable to debug, so
  # check the hash the project publishes rather than trusting the transfer.
  if curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; then
    expected=$(grep " ${name}.tar.xz\$" "$tmp/SHASUMS256.txt" | awk '{print $1}')
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$tmp/${name}.tar.xz" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$tmp/${name}.tar.xz" | awk '{print $1}')
    else
      actual=""
    fi
    if [ -n "$expected" ] && [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
      rm -rf "$tmp"
      die "Checksum mismatch on the Node download — refusing to use it."
    fi
    [ -n "$actual" ] && say "Checksum verified."
  fi

  say "Unpacking..."
  tar -xJf "$tmp/${name}.tar.xz" -C "$tmp" || die "Could not unpack the Node archive."

  rm -rf "$NODE_DIR"
  mv "$tmp/${name}" "$NODE_DIR"
  rm -rf "$tmp"
  say "Node ${NODE_VERSION} ready in ./${NODE_DIR}"
}

# 1. A previous bootstrap wins: if we downloaded a Node before, keep using it, so the
#    app does not change runtime underneath the compiled better-sqlite3 binary.
if [ -x "$NODE_DIR/bin/node" ] && supported "$(node_major "$NODE_DIR/bin/node")"; then
  say "Using bootstrapped Node $("$NODE_DIR/bin/node" -v) from ./${NODE_DIR}"
# 2. Otherwise a good system Node means we download nothing at all.
elif command -v node >/dev/null 2>&1 && supported "$(node_major "$(command -v node)")"; then
  say "Using system Node $(node -v)"
else
  bootstrap_node
fi

if [ -x "$NODE_DIR/bin/node" ]; then
  PATH="$(pwd)/$NODE_DIR/bin:$PATH"
  export PATH
fi

# node_modules holds a compiled native module, so reinstall whenever the lockfile is
# newer than the tree — otherwise a `git pull` leaves a stale build behind.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say "Installing dependencies..."
  npm install
fi

# Freshness is not enough: an earlier `npm install` under the system's older Node can
# leave behind a better-sqlite3 built for the wrong ABI, which fails only later, at the
# first database call, as a NODE_MODULE_VERSION error. Ask the module to load now, while
# we can still fix it.
if [ -d node_modules ] && ! node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  say "Existing dependencies were built for a different Node — reinstalling..."
  rm -rf node_modules
  npm install
fi

say ""
if [ -n "$LAN" ]; then
  # Asked of the Node we just settled on, so the private ./.node build answers it too.
  lan_ip=$(node -e '
    const nets = require("os").networkInterfaces();
    for (const list of Object.values(nets))
      for (const n of list || [])
        if (n.family === "IPv4" && !n.internal) { console.log(n.address); process.exit(0); }
  ' 2>/dev/null || true)

  say "Starting Smarti Board on http://localhost:3000"
  if [ -n "$lan_ip" ]; then
    say "  ...and on http://${lan_ip}:3000 for other devices on this network"
  else
    say "  ...and on the LAN address of this machine, port 3000 (could not detect which)"
  fi
  say ""
  say "  !  No password. Anyone who can reach that address can read and edit"
  say "  !  every board, and spend whatever model provider key you configured."
  say "  !  Use it on a network you trust."
  say ""
  SMARTI_HOST=0.0.0.0
  export SMARTI_HOST
  # v4.1's access gate reads this: bound wide *and* vouched for means every caller
  # is 'trusted' and reaches everything, which is exactly what this flag has meant
  # since v2.5 and what the warning above describes. Without it a wide binding is
  # gated, and only a share token gets in — that is the desktop's mode, not this
  # one. Not persisted, like the binding itself: it belongs to the invocation.
  SMARTI_TRUST_LAN=1
  export SMARTI_TRUST_LAN
  exec npm run dev
fi
say "Starting Smarti Board on http://localhost:3000"
say ""
exec npm run dev
