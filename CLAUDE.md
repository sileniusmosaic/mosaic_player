# mosaic_player — working conventions

This file is read automatically by Claude sessions working in this repo, so
the deploy mechanics below don't need to be re-discovered (or misremembered)
every session. Product/design decisions and history live in Claude's own
persistent memory, not here — this file is specifically about how a change
actually gets shipped.

## Two builds: staging (internal) and live (production)

- **Live site** (what testers already use): https://mosaic-player.silenius.workers.dev
- **Staging site** (internal/in-progress work): https://mosaic-player-staging.silenius.workers.dev
- Both are the SAME Cloudflare Worker codebase, deployed as two separate
  named environments in `wrangler.jsonc` (`env.staging`, plus the unnamed
  top-level env for production) — not classic Cloudflare Pages, no GitHub
  Actions, nothing deploys automatically on push.
- Staging has its own separate `ADMIN_CONFIG` KV namespace (admin-console
  edits there never touch live config/notation data) and no `ADMIN_PASSPHRASE`
  requirement at all (dropped on purpose — zero friction for dev/admin work).
  It also has no `ANALYTICS_DB` binding, so staging traffic never pollutes
  real usage analytics.

## Deploy pipeline — READ THIS BEFORE SUGGESTING A DEPLOY COMMAND

**Default assumption: new/changed code goes to staging. Live only gets
updated when Pat explicitly asks for it — never as the automatic "next
step" after a change, even one that looks small or safe.** A session once
handed over the live-deploy command as the default "ship it" step right
after a feature build, which pushed untested work straight to the live URL
by mistake — that must not happen again.

- `git push origin main` backs the change up to GitHub — safe to suggest any
  time, doesn't affect either site.
- `npx wrangler deploy --env staging` publishes to the staging URL — safe to
  suggest any time Pat wants to test something; no gate on this one.
- Deploying to LIVE (`wrangler deploy` targeting the top-level/production
  environment) must **only** happen through `./deploy-live.sh` at the repo
  root — never hand over a raw `npx wrangler deploy --env=""` command
  directly, even if Pat seems to be asking for a normal deploy; point him at
  the script instead. `deploy-live.sh` will not actually deploy unless the
  correct passphrase is typed first — a plain local passphrase, completely
  separate from `ADMIN_PASSPHRASE`, stored only in `.live_deploy_passphrase`
  (gitignored + asset-ignored, never committed, never read or asked for by
  Claude). Set/change it with `./set-live-deploy-passphrase.sh`. This exists
  specifically as a safety catch against exactly the mistake above — treat
  the passphrase gate as intentional friction, not an obstacle to route
  around.
- Note that `wrangler deploy` — for either environment — now requires an
  explicit `--env` flag once more than one environment exists in the config
  (a newer Wrangler version added this safety prompt): `--env staging` for
  staging, `--env=""` for the top-level/production config. `deploy-live.sh`
  already has this baked in; only worth remembering if giving a raw command
  for some other reason (staging, mainly).
- Watch `.assetsignore` if a deploy ever fails with "asset too large" — it
  needs to mirror `.gitignore` for anything under `Mosaic/*/raw/` (raw
  masters and ffmpeg build artifacts easily exceed Workers' 25MiB per-asset
  cap).

### If Pat asks to go live

Confirm that's really what he wants (not "deploy" in the generic sense —
staging is the default target), then hand him:

```bash
git push origin main && ./deploy-live.sh
```

He'll be prompted for the live-deploy passphrase; nothing goes live unless
he enters it correctly.

## What Claude can and can't do directly in this repo

- **Editing files**: yes, directly (e.g. via a device-bridge connection to
  his Mac), matching the existing file's mtime so there's no silent
  overwrite of unseen edits. No need to ask first.
- **`git commit`**: yes, automatically, no need to ask first (updated Sep 10
  2026 — supersedes an earlier "always ask first" rule that used to live
  here; this is a standing preference, not specific to this repo).
- **`git push` / `npx wrangler deploy` / `./deploy-live.sh`**: Claude cannot
  run any of these from a sandboxed cloud/device-bridge session — both
  github.com and the npm/Cloudflare registries are network-blocked from
  there (confirmed: 403 from the proxy on both), and `deploy-live.sh`
  specifically needs an interactive passphrase prompt only Pat should ever
  see/answer. Don't keep retrying — hand the right command over for Pat to
  run in his own Terminal instead (staging or GitHub push: give the raw
  command directly; live: give `./deploy-live.sh`, per the section above).

## Admin console / config backend

- `worker.js` also serves a small JSON-over-KV settings API (`/api/config`,
  `/api/admin/*`) backing `admin.html` — play order, per-piece metronome
  offset, per-stem volume trim, tile order, and (Sep 2026) per-tile notation
  image overrides. Changes made through `admin.html` go live immediately via
  Cloudflare KV — no commit/push/deploy needed for those.
- On the LIVE site, admin write routes require the `ADMIN_PASSPHRASE` Worker
  secret (set via `wrangler secret put ADMIN_PASSPHRASE`, never committed to
  the repo). On STAGING, there is no admin passphrase at all (see above) —
  do not confuse the two, or assume one implies anything about the other.
- **Notation admin UI** (Sep 20 2026 rewrite): the notation-images page is
  now one instrument at a time — outer arrows cycle the 8 squares, inner
  arrows cycle that square's uploaded images, "Edit" changes just an
  existing image's bar list in place (`/api/admin/notation-bars-update`, no
  re-upload). Both the login screen and every page show an unmissable
  STAGING/LIVE banner (`admin.html`'s `IS_STAGING`, from `location.hostname`
  — same signal the staging passphrase-bypass already used).
- **Send to live**: on staging only, a variant's action row gets a "Send to
  live" button that copies that exact tested image (bytes + bar list)
  straight into production's own KV, server-side
  (`/api/admin/notation-promote-live`) — no second browser upload, so
  nothing can drift between what was tested and what goes live. Staging's
  Worker has a SECOND KV binding for this, `LIVE_ADMIN_CONFIG` (in
  `wrangler.jsonc`'s `env.staging`), pointing at production's own
  `ADMIN_CONFIG` namespace id — deliberately named differently so the code
  never confuses "my own store" with "the live store". Gated by its own
  `LIVE_ADMIN_PASSPHRASE` secret on the staging environment specifically
  (separate from `ADMIN_PASSPHRASE`, and separate from staging's normal
  no-passphrase policy — this one write path always needs it regardless of
  environment). **One-time setup Pat needs to run himself** (Claude can't —
  same network restriction as any other `wrangler` command):
  `npx wrangler secret put LIVE_ADMIN_PASSPHRASE --env staging`, typing the
  same passphrase as production's `ADMIN_PASSPHRASE` when prompted. Until
  that's set, "Send to live" will 401 every time.
