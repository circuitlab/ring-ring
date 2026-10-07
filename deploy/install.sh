#!/bin/sh
# Install or update ring-ring as a systemd service. Run with sudo.
#
# A pinned Node.js runtime is installed under /opt/ring-ring/node, since the
# distribution's Node is too old for @discordjs/voice.
#
# If deploy/ring-ring.env exists it is installed as the service config
# (overwriting the current one); otherwise the example is installed once.
set -eu
cd "$(dirname "$0")/.."

NODE_VERSION=v24.21.0
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
PREFIX=/opt/ring-ring

install -d -m 755 "$PREFIX" "$PREFIX/src"

if [ "$("$PREFIX/node/bin/node" --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    tarball="node-$NODE_VERSION-linux-x64.tar.xz"
    curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
    echo "$NODE_SHA256  $tmp/$tarball" | sha256sum -c --quiet
    mkdir "$tmp/node"
    tar -xJf "$tmp/$tarball" -C "$tmp/node" --strip-components=1 --no-same-owner
    rm -rf "$PREFIX/node"
    mv "$tmp/node" "$PREFIX/node"
    chmod 755 "$PREFIX/node"
fi

install -m 644 package.json package-lock.json "$PREFIX/"
install -m 644 src/*.ts "$PREFIX/src/"
(cd "$PREFIX" && PATH="$PREFIX/node/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-fund --no-audit --loglevel=error)

install -m 644 deploy/ring-ring.service /etc/systemd/system/ring-ring.service
install -m 644 deploy/50-ring-ring.rules /etc/polkit-1/rules.d/50-ring-ring.rules
systemctl daemon-reload

install -d -m 750 -o root -g circuitlab /etc/ring-ring
if [ -e deploy/ring-ring.env ]; then
    install -m 640 -o root -g circuitlab deploy/ring-ring.env /etc/ring-ring/ring-ring.env
elif [ ! -e /etc/ring-ring/ring-ring.env ]; then
    install -m 640 -o root -g circuitlab deploy/ring-ring.env.example /etc/ring-ring/ring-ring.env
    echo "Edit /etc/ring-ring/ring-ring.env, then: sudo systemctl enable --now ring-ring"
    exit 0
fi

if systemctl is-enabled --quiet ring-ring; then
    systemctl restart ring-ring
    echo "Restarted. Logs: journalctl -u ring-ring -f"
else
    echo "Installed. Start with: sudo systemctl enable --now ring-ring"
fi
