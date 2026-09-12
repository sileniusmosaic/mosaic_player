#!/usr/bin/env bash
# Sets/changes the passphrase deploy-live.sh checks before it will deploy to
# the live/production Worker — see deploy-live.sh's own header comment for
# the full story. Run this once to set it up, and again any time you want to
# change it. The value you type here is written ONLY to the local,
# gitignored/asset-ignored .live_deploy_passphrase file — it is never
# committed, never uploaded as a site asset, and never seen by Claude.
set -euo pipefail
cd "$(dirname "$0")"

read -r -s -p "Set a new live-deploy passphrase: " PASS1
echo
read -r -s -p "Confirm it: " PASS2
echo

if [ "$PASS1" != "$PASS2" ]; then
  echo "Those didn't match — nothing saved. Try again."
  exit 1
fi
if [ -z "$PASS1" ]; then
  echo "Passphrase can't be empty — nothing saved."
  exit 1
fi

printf '%s' "$PASS1" > .live_deploy_passphrase
chmod 600 .live_deploy_passphrase
echo "Live-deploy passphrase saved to .live_deploy_passphrase (gitignored, stays on this machine)."
