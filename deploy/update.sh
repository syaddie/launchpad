#!/bin/sh
# Pull the latest Launchpad image and restart only if it changed.
# Run from cron on the server, e.g. every 5 minutes:
#   */5 * * * * /home/<you>/launchpad/deploy/update.sh >> /home/<you>/launchpad/update.log 2>&1
set -eu
cd "$(dirname "$0")/.."
docker compose pull --quiet launchpad
# `up -d` is a no-op when the image is unchanged; otherwise it recreates the container.
docker compose up -d --no-build launchpad 2>&1 | grep -v -i "running\|up-to-date" || true
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/syaddie/launchpad" >/dev/null
