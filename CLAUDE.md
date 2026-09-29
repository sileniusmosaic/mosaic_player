# mosaic_player — working conventions

This file is read automatically by Claude sessions working in this repo, so
the deploy mechanics below don't need to be re-discovered (or misremembered)
every session. Product/design decisions and history live in Claude's own
persistent memory, not here — this file is specifically about how a change
actually gets shipped.

## Audio tempo-variant pipeline — READ THIS before building 75%/50%(/25%) stems for any piece

See `AUDIO_TEMPO_PIPELINE.md` in this repo root. Written Sep 29 2026 after the
original process for Congo/Flip Swing/Abakuá's tempo audio was lost — it had
never been written down, only existed in an old Claude conversation nobody
could find again, and cost a long, frustrating debugging saga on Shaker as a
result. Don't let that happen again: read that file first, and if the process
ever changes, update that file in the same session, not just this repo's git
history or Claude's memory alone.

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

## Pat's browser — READ BEFORE ANY BROWSER/COMPATIBILITY DISCUSSION

**Pat uses Chrome, exclusively, on every platform — desktop and mobile/phone
alike. Never Safari, never assume Safari, never reference "iOS Safari" or a
Safari-style UI when discussing what he sees.** This has been corrected
more than once in session (most recently Sep 28 2026, after a session
twice referred to "Safari"/"iOS Safari" and assumed a Safari-only
certificate-detail panel that doesn't exist in his browser) — treat any
future browser-specific troubleshooting as Chrome-on-desktop or
Chrome-on-mobile, never Safari on either. Note for context only (not a
reason to second-guess what he reports): Apple requires third-party iOS
browser apps, including Chrome for iOS, to use Apple's WebKit engine
internally, so Chrome on an iPhone can occasionally show WebKit-flavored
quirks (e.g. around certificate warnings) even though it's genuinely
Chrome, not Safari — explain the discrepancy this way if it comes up, don't
use it to imply he's "really" using Safari.

## Platform-pair rule (desktop vs. mobile) — READ BEFORE ANY CSS/layout CHANGE

**A change scoped to one platform (desktop or mobile/portrait) must never be
able to visually affect the other.** This is a hard rule, not a guideline —
violating it has shipped a real regression to the live site before (Sep 28
2026: the mobile-portrait "piece-strip-bar" thumbnails, which should be
permanently hidden in favor of the scrollable piece-mockup cards, reappeared
live on mobile because the CSS rule hiding it on mobile had been silently
dropped during an unrelated desktop-focused edit — nobody noticed until it
was already live, because desktop was tested but mobile wasn't re-checked).

What this means in practice:

- Any CSS toggle that shows exactly one of two elements/behaviors depending
  on platform (`.is-desktop X{display:none}` paired with a mobile-side
  show, or vice versa) is a MATCHED PAIR. Never edit one half without
  re-reading and confirming the other half still exists and still says what
  you think it says. Grep for the element's selector across the whole file
  before touching either half, not just the one you're changing.
- Before calling ANY layout/CSS change done — even one that only *mentions*
  one platform ("make desktop match mobile", "just for portrait") — run the
  Playwright verification pass on BOTH a desktop viewport (~1400px wide,
  hasTouch:false) and a mobile-portrait viewport (390x844, isMobile:true).
  A change that should be platform-scoped but isn't caught by CSS
  specificity/cascade will otherwise only show up on whichever platform
  nobody happened to check.
- When restructuring markup shared by both platforms (moving an element,
  adding a wrapper), explicitly verify the OTHER platform's DOM
  order/parent-child relationships and rendered rects are byte-for-byte
  unchanged, not just that the platform you're working on now looks right.
- Prefer `display:contents` wrapper elements (the established pattern
  throughout this file — see `.focus-stack`/`.focus-main-row`/
  `.piece-mockup-row`) over duplicating markup per platform, since a
  wrapper's mobile-safety is a single rule to audit rather than two
  divergent DOM trees to keep in sync by hand.
- If a platform-scoped rule is ever DELETED (not just edited), grep first
  for whether it was one half of a pair — deleting "the desktop half" of a
  pair without noticing there was ALSO a "the mobile half" is exactly the
  Sep 28 2026 bug above.

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

## Video composite build pipeline — READ THIS before building/rebuilding ANY tile video, single-pass only

Written Sep 29 2026, after Pat noticed Shaker and Afrobeat's video looked
visibly lower quality than Abakuá/Congo/Flip Swing despite "same camera, same
lights, same settings." Root-caused with real measurements (see below) - two
real causes, don't let either recur.

**Cause 1 (real, measured, applies to any piece): always build the whole
composite in ONE ffmpeg pass, straight from the raw master(s), never as
separate per-tile files that get hstacked/vstacked in a second pass.**
Abakuá/Congo/Flip Swing's established scripts (`Mosaic/*/raw/build_*.sh`) all
do this correctly: every tile's crop/scale/tempo-setpts is a node in one
`-filter_complex` feeding straight into `hstack`/`vstack`, with exactly ONE
final `-c:v libx264` encode. Shaker and Afrobeat's builds this session instead
wrote each tile to its own separate crf23-encoded file first, then re-encoded
AGAIN when combining them into the composite - a second full lossy H.264
generation. Measured with ffmpeg's own `ssim`/`psnr` filters against a
crf-0 (near-lossless) reference built straight from the raw master: Afrobeat's
double-pass Tumba tile scored PSNR avg 38.4dB (worst frame 21.9dB - a real,
visible artifact) vs a fresh single-pass rebuild's 41.1dB avg (worst frame
40.2dB) - a clear, meaningful loss purely from the redundant re-encode, not
from the camera/lighting/source. Fixed by rebuilding both Shaker and Afrobeat
as single-pass composites (commits after this file's own Sep 29 update) -
when a piece needs one tile to have unique per-tile treatment (a crop, a
flip, recovered footage from an old commit), feed that tile's file straight
into the SAME final `-filter_complex`/hstack alongside the other raw-sourced
tiles, rather than pre-baking it into its own separate intermediate encode
first. Every extra intermediate encode is a lossy generation - avoid all of
them, not just most.

**Cause 2 (real, but on Pat's end, not fixable by rebuilding): check the raw
export's own bitrate before assuming a build-pipeline problem.** Shaker's raw
masters (`shaker square.mov`, `shaker2.mov`) are H.264 2160x2160 60fps at only
~2.8Mbps/~5.4Mbps. Afrobeat's raw masters are the exact same
codec/resolution/frame-rate but ~71Mbps - a 13-25x difference. Same camera,
same resolution, same fps, wildly different source bitrate - something in the
Final Cut export (or a lossy transfer step) compressed those two Shaker clips
far more than usual. No amount of rebuilding the composite recovers detail
that was never in the source; if a future piece looks soft despite a clean
single-pass build, `ffprobe -select_streams v:0 -show_entries stream=bit_rate`
the raw master FIRST and compare it to a known-good piece's raw master before
assuming the pipeline is at fault.

**Practical check for any future "does this look right" quality question**:
don't just eyeball it - `ffprobe` the raw master's bitrate, and if you have a
suspect build, ffmpeg's `-lavfi ssim`/`-lavfi psnr` against a crf-0 rebuild of
the same source segment gives an objective, comparable number instead of a
guess. A small final file size alone is not proof of a problem (a short/small
canvas piece is legitimately smaller than an 8-tile 45s one) - but it's a
reason to run this check, not a reason to skip it.
