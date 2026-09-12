#!/usr/bin/env bash
# Live-deploy safety gate (Sep 12 2026, real request — see CLAUDE.md's
# "Deploy pipeline" section for the full story). A raw `npx wrangler deploy
# --env=""` deploy landed an untested build straight to the live URL once
# already, when the real intent was "test on staging first, only go live
# when I actually ask." From now on this script is the ONLY sanctioned way
# to deploy to the live/production Worker: it will not run
# `wrangler deploy --env=""` at all unless the correct passphrase is typed
# first. That passphrase is completely separate from ADMIN_PASSPHRASE (the
# Cloudflare Worker secret that gates admin.html's write routes) — this one
# lives only in .live_deploy_passphrase, a plain local file, gitignored and
# asset-ignored, that never leaves this machine and Claude never asks for,
# reads, or stores. Set/change it with ./set-live-deploy-passphrase.sh.
#
# Staging is UNAFFECTED by this gate on purpose — `npx wrangler deploy
# --env staging` still runs directly, any time, no passphrase, exactly as
# before. This script only guards the production/live deploy.
set -euo pipefail
cd "$(dirname "$0")"

PASS_FILE=".live_deploy_passphrase"
if [ ! -f "$PASS_FILE" ]; then
  echo "No live-deploy passphrase has been set yet."
  echo "Run ./set-live-deploy-passphrase.sh first, then try this again."
  exit 1
fi

STORED="$(cat "$PASS_FILE")"
read -r -s -p "Enter live-deploy passphrase: " ENTERED
echo
if [ "$ENTERED" != "$STORED" ]; then
  echo "Incorrect passphrase — live deploy CANCELLED. Nothing was pushed."
  exit 1
fi

echo "Passphrase correct — deploying to LIVE (mosaic-player.silenius.workers.dev)..."
npx wrangler deploy --env=""
