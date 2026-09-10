# mosaic_player — working conventions

This file is read automatically by Claude sessions working in this repo, so
the deploy mechanics below don't need to be re-discovered (or misremembered)
every session. Product/design decisions and history live in Claude's own
persistent memory, not here — this file is specifically about how a change
actually gets shipped.

## Deploy pipeline (there is no CI / no auto-deploy-on-push)

- Live site: https://mosaic-player.silenius.workers.dev
- This is a Cloudflare Worker with static assets (`wrangler.jsonc`), **not**
  classic Cloudflare Pages. There is no GitHub Actions workflow in this repo
  and nothing deploys automatically when you push.
- GitHub (`sileniusmosaic/mosaic_player`) is the code's backup/history.
  **Pushing to GitHub does not update the live site.** `wrangler deploy`
  publishes straight from the local working directory, not from GitHub.

So shipping a change is always two independent steps, in either order:

1. `git push origin main` — backs the change up to GitHub (Pat's usual tool
   for this is GitHub Desktop; plain `git push` does the same thing).
2. `npx wrangler deploy` — actually publishes the change live.

A quick one-liner for both at once, from the repo root:

```bash
git push origin main && npx wrangler deploy
```

Watch `.assetsignore` if a deploy ever fails with "asset too large" — it
needs to mirror `.gitignore` for anything under `Mosaic/*/raw/` (raw masters
and ffmpeg build artifacts easily exceed Workers' 25MiB per-asset cap).

## What Claude can and can't do directly in this repo

- **Editing files**: yes, directly (e.g. via a device-bridge connection to
  his Mac), matching the existing file's mtime so there's no silent
  overwrite of unseen edits. No need to ask first.
- **`git commit`**: yes — but always ask first and wait for an explicit
  go-ahead. This is a standing preference, not specific to this repo.
- **`git push` / `npx wrangler deploy`**: Claude cannot run either of these
  from a sandboxed cloud/device-bridge session — both github.com and the
  npm/Cloudflare registries are network-blocked from there (confirmed: 403
  from the proxy on both). Don't keep retrying — hand over the one-liner
  above for Pat to paste into his own Terminal instead.

## Admin console / config backend

- `worker.js` also serves a small JSON-over-KV settings API (`/api/config`,
  `/api/admin/*`) backing `admin.html` — play order, per-piece metronome
  offset, per-stem volume trim, tile order, and (Sep 2026) per-tile notation
  image overrides. Changes made through `admin.html` go live immediately via
  Cloudflare KV — no commit/push/deploy needed for those.
- Admin write routes require the `ADMIN_PASSPHRASE` Worker secret (set via
  `wrangler secret put ADMIN_PASSPHRASE`, never committed to the repo).
