#!/bin/sh
set -eu
public_url=${OPENBOARD_PUBLIC_URL:-http://127.0.0.1:8080}
authority=${public_url#*://}
exec curl --fail --silent --show-error --max-time 10 \
  --header "Host: $authority" --output /dev/null \
  "http://127.0.0.1:${OPENBOARD_PORT:-8080}/api/ready"
