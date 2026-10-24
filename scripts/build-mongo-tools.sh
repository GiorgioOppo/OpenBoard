#!/bin/sh
# Preserve all official tools, including GSSAPI support, while fixing the Go
# runtime and x/net dependency. No runtime scanner findings are suppressed.
set -eu
mkdir -p /src/mongo-tools /out/bin /out/js-yaml
curl -fsSL https://codeload.github.com/mongodb/mongo-tools/tar.gz/refs/tags/100.19.1 -o /tmp/tools.tgz
printf '%s  %s\n' 5f8bbd54e76804985d73b66313d7485724396a6ae47135e9bcb57a8a49f4279c /tmp/tools.tgz | sha256sum -c -
tar -xzf /tmp/tools.tgz --strip-components=1 -C /src/mongo-tools
cd /src/mongo-tools
# The release vendors x/net 0.59.0. Use a checksum-verified module download
# instead; 0.61.0 includes the October security corrections and maintenance fixes.
go mod edit -require=golang.org/x/net@v0.61.0
GOFLAGS=-mod=mod go mod download golang.org/x/net
GOFLAGS=-mod=mod go mod download
# Pin the selected module's official checksum as well as checking the cache.
grep -Fx 'golang.org/x/net v0.61.0 h1:RR+6j/BTBCrggOLugxa+66R8FvoN6MHlzDlZIbN9YFw=' go.sum
grep -Fx 'golang.org/x/net v0.61.0/go.mod h1:WgDCOTH8iwtB66T4/GfI94AHo/hhdb7Hah9NDseQfiI=' go.sum
go mod verify
for tool in bsondump mongodump mongorestore mongoimport mongoexport mongostat mongotop mongofiles; do
    CGO_ENABLED=1 go build -mod=mod -trimpath -buildvcs=false -buildmode=pie \
        -tags=gssapi,failpoints \
        -ldflags='-X main.VersionStr=100.19.1-openboard.2 -X main.GitCommit=9348e032419d906e40966f477278cce647b9b1eb' \
        -o "/out/bin/$tool" "$tool/main/$tool.go"
    go version -m "/out/bin/$tool"
    "/out/bin/$tool" --version
done
# MongoDB's official entrypoint loads this browser bundle in mongosh. Stay on
# the compatible 3.x API and retain the existing /js-yaml.js symlink.
curl -fsSL https://registry.npmjs.org/js-yaml/-/js-yaml-3.15.2.tgz -o /tmp/js-yaml.tgz
printf '%s  %s\n' 7f005cf0b8ee639b4557e0e321dc067c1f2aa0a442d096e03f2ab53353738794 /tmp/js-yaml.tgz | sha256sum -c -
tar -xzf /tmp/js-yaml.tgz --strip-components=1 -C /out/js-yaml package/dist/js-yaml.js package/package.json
