#!/bin/sh
# Rebuild the official 1.19 source with the patched Go toolchain. Keep debug
# symbols: upstream recommends them for binary govulncheck reachability checks.
set -eu
export CGO_ENABLED=0 GOTOOLCHAIN=local
mkdir -p /src/gosu /out
curl -fsSL https://codeload.github.com/tianon/gosu/tar.gz/refs/tags/1.19 -o /tmp/gosu.tgz
printf '%s  %s\n' cd9719b775dbfedae53923c9b0dc792b66d42c51e0b36652ed6f747fbadc0164 /tmp/gosu.tgz | sha256sum -c -
tar -xzf /tmp/gosu.tgz --strip-components=1 -C /src/gosu
cd /src/gosu
go mod download
go mod verify
# Use the same version-metadata shim as the official gosu build. This preserves
# the 1.19.0 package identity for scanners, rather than reporting UNKNOWN/devel.
curl -fsSL https://raw.githubusercontent.com/tianon/fake-git/aaa875961611764a86a21cf80c250929a7786179/fake-git.sh -o /usr/local/bin/git
printf '%s  %s\n' 6ffaef5b0b820070c02253fb27bd07f62d1e501e757f71d8b501f1c8e17d828e /usr/local/bin/git | sha256sum -c -
chmod 0755 /usr/local/bin/git
mkdir .git
export FAKEGIT_GO_SEMVER=v1.19.0 FAKEGIT_GO_REVISION=1.19
go build -trimpath -buildvcs=true -ldflags='-d -w' -o /out/gosu github.com/tianon/gosu
go version -m /out/gosu
/out/gosu --version
/out/gosu nobody true
