#!/bin/sh
set -eu

mkdir -p /data/db /data/repos /tmp/mendpoint-transformer
chown -R node:node /data /tmp/mendpoint-transformer
chmod 700 /data /data/db /data/repos /tmp/mendpoint-transformer

exec gosu node "$@"
