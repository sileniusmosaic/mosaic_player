// Admin-configurable settings backend (Sep 2026).
//
// This Worker used to not exist at all — the site was pure static assets
// (see wrangler.jsonc's "assets" block). Two small API routes are added here
// so the admin console (admin.html) can publish changes — mosaic play order,
// a per-piece metronome click "nudge" in milliseconds, and (Sep 7 2026) a
// per-piece, per-stem volume trim in dB — that take effect immediately for
// every visitor, without a new deploy each time. Every other request just
// falls through to the static assets exactly as before.
//
// Storage: a single JSON blob in the ADMIN_CONFIG KV namespace under the key
// "config" (see wrangler.jsonc's kv_namespaces binding). KV is a fine fit
// here — this is small, infrequently-written, read-heavy settings data, not
// a database workload.
//
// Auth: the admin passphrase is a Worker secret (ADMIN_PASSPHRASE), set via
// `wrangler secret put ADMIN_PASSPHRASE` from a terminal — never committed to
// the repo. admin.html asks for it client-side purely for a friendlier UI
// (so you're not staring at a blank page); the REAL check is here, on every
// write — a request without the correct passphrase is rejected regardless of
// what the page's own JS does or doesn't check.
//
// Per-bar notation images (Sep 9 2026): a piece's per-tile notation strip
// (mosaic_webcodecs.html's cfg.notationStripByIndex) used to be exactly one
// static PNG per tile, committed to git. Admin can now upload one or more
// PNGs per tile straight from admin.html, each one either the tile's base
// image ("all" bars) or scoped to a specific list of bar numbers (e.g. "only
// during bars 6 and 12") — no git commit/deploy needed for a notation
// change. The metadata (which bars each variant covers) lives in the same
// KV "config" blob as everything else above; the actual PNG bytes live in
// their OWN KV keys (see notationImgKey()) rather than inline in that blob,
// so /api/config stays small and fast to fetch on every page load. See
// BAR_COUNTS below for why bar validation is soft, not hard-enforced.

const KNOWN_MOSAIC_IDS = ['flipswing', 'abakua', 'congo'];

// Stem/tile count per piece — one audio stem = one visual tile, so this one
// count validates both stemGainDb (audio) and tileOrder (visual grid
// position) below. Index-aligned with mosaic_webcodecs.html's MOSAICS[id]
// .names/.stemFiles (stemGainDb[id][k]/tileOrder[id] entries refer to
// names[k]). Only the COUNT matters here for validation; admin.html keeps
// its own copy of the actual names for display. If a piece's tile count ever
// changes, update it in all three places (here, admin.html, and the MOSAICS
// entry in mosaic_webcodecs.html) — there's no shared source of truth across
// these static files.
const STEM_COUNTS = { flipswing: 8, abakua: 8, congo: 8 };

// Total bar count per piece, for admin.html's own UI hints only (e.g. "bars
// 1-19") — mirrors mosaic_webcodecs.html's MOSAICS[id].bars. Congo was BPM-
// only (no fixed bar count) until Sep 10 2026, when it was given an exact
// `bars:8` there too (24.000s loop x 80bpm/60 = 32 beats / 4 beats-per-bar =
// 8 bars exactly, not a guess — see that file's own comment) specifically so
// per-bar notation variants could work for it. null here would mean "no bar
// count, base image only" for a future piece that hasn't been given one yet.
// Deliberately NOT hard-enforced server-side beyond "a positive integer"
// (see validateBars() below) — a bar count changing is a UI-hint update
// only, never a reason a valid upload gets rejected.
const BAR_COUNTS = { flipswing: 12, abakua: 19, congo: 8 };

// Usage analytics (Sep 10 2026) — anonymous session pings so the admin
// console can show which pieces get played, for how long, at what tempo,
// and what's muted. Deliberately minimal: ONE D1 table (pings, see
// ANALYTICS_DB in wrangler.jsonc), no user identity beyond a random
// per-visit sessionId the browser generates itself (see
// mosaic_webcodecs.html) — no IP, no device info, no names. A 'start'
// ping fires once on page load (so "connections" counts a visit even if
// the person never presses play); 'heartbeat' pings fire roughly every
// ANALYTICS_HEARTBEAT_SECONDS while something is actually playing, via
// navigator.sendBeacon — fire-and-forget, off the audio/video path
// entirely, so there's no perceptible overhead. Play time per piece/tempo
// is then just (heartbeat count * this interval) at digest time — no
// separate "session end" event needed (unreliable on mobile anyway), and a
// dropped ping just slightly undercounts rather than breaking anything.
const ANALYTICS_HEARTBEAT_SECONDS = 25;
const ANALYTICS_TEMPOS = [25, 50, 75, 100];
const ANALYTICS_KINDS = ['start', 'heartbeat'];
const MAX_MUTED_TILES_FIELD = 64; // generous cap on the raw "0,3,5" string length

const STEM_GAIN_DB_MIN = -18;
const STEM_GAIN_DB_MAX = 18;

// Cap on stored PNG size — generous for a notation-strip crop (typically
// 20-60KB today) while keeping a single KV value (25MB hard limit) and a
// single admin upload request reasonably sized.
const MAX_NOTATION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BARS_PER_VARIANT = 200;

function defaultStemGainDb() {
  const out = {};
  for (const id of KNOWN_MOSAIC_IDS) out[id] = new Array(STEM_COUNTS[id]).fill(0);
  return out;
}

// tileOrder[id] is a permutation of 0..count-1 — tileOrder[id][slot] is which
// tile (by its one true logical index, same as stemGainDb above) is drawn in
// grid position `slot`. Identity (0,1,2,...) is "not reordered", same
// convention as the default.
function defaultTileOrder() {
  const out = {};
  for (const id of KNOWN_MOSAIC_IDS) out[id] = Array.from({ length: STEM_COUNTS[id] }, (_, i) => i);
  return out;
}

function defaultNotationOverrides() {
  const out = {};
  for (const id of KNOWN_MOSAIC_IDS) out[id] = {};
  return out;
}

const DEFAULT_CONFIG = {
  order: KNOWN_MOSAIC_IDS.slice(),
  metroOffsetMs: { flipswing: 0, abakua: 0, congo: 0 },
  stemGainDb: defaultStemGainDb(),
  tileOrder: defaultTileOrder(),
  notationOverrides: defaultNotationOverrides(),
};

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// "bars" on a variant is either the literal string 'all' (the tile's base/
// fallback image) or a non-empty array of distinct positive integers (the
// specific bar numbers, 1-indexed to match how a musician actually counts
// bars, during which this image should replace the base one). Deliberately
// NOT checked against BAR_COUNTS[id] here — see that map's own comment —
// so a bar number is only rejected for being malformed, never for being
// "too high" against a count this file happens to know about today.
function validateBars(bars) {
  if (bars === 'all') return 'all';
  if (!Array.isArray(bars) || bars.length === 0 || bars.length > MAX_BARS_PER_VARIANT) return null;
  const seen = new Set();
  for (const v of bars) {
    if (!Number.isInteger(v) || v < 1 || v > 9999) return null;
    seen.add(v);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

function sameBars(a, b) {
  if (a === 'all' || b === 'all') return a === b;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// Merges whatever's actually in KV with the defaults, so a half-populated or
// stale blob (e.g. from before a new mosaic was added) never breaks the
// player — every known id always ends up with a valid order position and a
// numeric offset.
function normalizeConfig(raw) {
  const cfg = { order: [], metroOffsetMs: {} };
  const rawOrder = Array.isArray(raw?.order) ? raw.order.filter(id => KNOWN_MOSAIC_IDS.includes(id)) : [];
  cfg.order = rawOrder.concat(KNOWN_MOSAIC_IDS.filter(id => !rawOrder.includes(id)));
  for (const id of KNOWN_MOSAIC_IDS) {
    const v = raw?.metroOffsetMs?.[id];
    cfg.metroOffsetMs[id] = (typeof v === 'number' && isFinite(v)) ? Math.max(-500, Math.min(500, v)) : 0;
  }
  cfg.stemGainDb = {};
  for (const id of KNOWN_MOSAIC_IDS) {
    const count = STEM_COUNTS[id];
    const rawArr = Array.isArray(raw?.stemGainDb?.[id]) ? raw.stemGainDb[id] : [];
    cfg.stemGainDb[id] = Array.from({ length: count }, (_, i) => {
      const v = rawArr[i];
      if (typeof v !== 'number' || !isFinite(v)) return 0;
      const clamped = Math.max(STEM_GAIN_DB_MIN, Math.min(STEM_GAIN_DB_MAX, v));
      return Math.round(clamped * 10) / 10; // 0.1dB precision is plenty
    });
  }
  // Same "keep whatever's valid, fill in whatever's missing" shape as
  // cfg.order above, just per-piece: drop out-of-range/duplicate entries,
  // then append whichever indices didn't survive that filter, in their
  // natural order — so a malformed or stale saved permutation always still
  // normalizes to SOME valid permutation rather than ever being rejected.
  cfg.tileOrder = {};
  for (const id of KNOWN_MOSAIC_IDS) {
    const count = STEM_COUNTS[id];
    const rawArr = Array.isArray(raw?.tileOrder?.[id]) ? raw.tileOrder[id] : [];
    const seen = new Set();
    const valid = [];
    for (const v of rawArr) {
      if (Number.isInteger(v) && v >= 0 && v < count && !seen.has(v)) { seen.add(v); valid.push(v); }
    }
    for (let i = 0; i < count; i++) if (!seen.has(i)) valid.push(i);
    cfg.tileOrder[id] = valid;
  }
  // notationOverrides[id][tileIndex] = [{id, bars, updatedAt}, ...] — the PNG
  // bytes themselves live in separate KV keys (notationImgKey()), NOT here;
  // a malformed/stale entry (bad tile index, bad bars, missing image key
  // that a stale blob might reference) is just dropped rather than fixed up,
  // since there's no sensible default image to fall back to per-variant —
  // the player already falls back to the piece's existing static
  // notationStripByIndex/notationStrip whenever no override applies.
  cfg.notationOverrides = {};
  for (const id of KNOWN_MOSAIC_IDS) {
    const count = STEM_COUNTS[id];
    const rawByTile = (raw?.notationOverrides && typeof raw.notationOverrides === 'object') ? raw.notationOverrides[id] : null;
    const byTile = {};
    if (rawByTile && typeof rawByTile === 'object') {
      for (const key of Object.keys(rawByTile)) {
        const tileIndex = Number(key);
        if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= count) continue;
        const rawVariants = Array.isArray(rawByTile[key]) ? rawByTile[key] : [];
        const variants = [];
        for (const v of rawVariants) {
          if (!v || typeof v !== 'object') continue;
          if (typeof v.id !== 'string' || !/^[a-z0-9]{4,32}$/i.test(v.id)) continue;
          const bars = validateBars(v.bars);
          if (bars === null) continue;
          const updatedAt = (typeof v.updatedAt === 'number' && isFinite(v.updatedAt)) ? v.updatedAt : Date.now();
          variants.push({ id: v.id, bars, updatedAt });
        }
        if (variants.length) byTile[tileIndex] = variants;
      }
    }
    cfg.notationOverrides[id] = byTile;
  }
  return cfg;
}

// Adds a ready-to-use `url` to every notation-override variant in a config
// object about to be sent to a client (both the player and admin.html) —
// derived, never stored in KV, so the URL scheme can change later without a
// migration. The `v=` query param is the variant's own updatedAt: replacing
// an image in place changes this, which changes the URL, which is what lets
// the image response below be cached aggressively (see /api/notation-image)
// without ever serving a stale replaced image.
function withNotationImageUrls(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const id of Object.keys(out.notationOverrides || {})) {
    const byTile = out.notationOverrides[id];
    for (const tileIndex of Object.keys(byTile)) {
      byTile[tileIndex] = byTile[tileIndex].map(v => ({
        ...v,
        url: `/api/notation-image/${id}/${tileIndex}/${v.id}?v=${v.updatedAt}`,
      }));
    }
  }
  return out;
}

function notationImgKey(pieceId, tileIndex, variantId) {
  return `notation-img:${pieceId}:${tileIndex}:${variantId}`;
}

function randomVariantId() {
  return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes) {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

// Accepts either a bare base64 string or a "data:image/png;base64,...." URL,
// since that's what a browser's FileReader.readAsDataURL() (the easiest way
// for admin.html to read an <input type=file>) actually produces.
function decodeBase64Image(input) {
  if (typeof input !== 'string' || !input) return null;
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  let binary;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readConfig(env) {
  const raw = await env.ADMIN_CONFIG.get('config', { type: 'json' });
  return normalizeConfig(raw || DEFAULT_CONFIG);
}

async function writeConfig(env, cfg) {
  await env.ADMIN_CONFIG.put('config', JSON.stringify(cfg));
}

function checkPassphrase(request, env) {
  const passphrase = request.headers.get('x-admin-passphrase') || '';
  // env.ADMIN_PASSPHRASE not yet set (secret never configured) → refuse
  // every write rather than silently accepting an empty passphrase.
  return !!env.ADMIN_PASSPHRASE && passphrase === env.ADMIN_PASSPHRASE;
}

// A random per-visit id the browser generates itself (see localStorage/
// sessionStorage use in mosaic_webcodecs.html) — validated only for shape
// (opaque token, not decoded/interpreted), never treated as identity.
function validSessionId(s) {
  return typeof s === 'string' && /^[a-z0-9]{12,40}$/i.test(s);
}

// "muted" on a ping is a comma-joined list of tile indices, e.g. "0,3,5", or
// '' for none — deliberately a plain string (not a JSON array) to keep the
// beacon payload tiny. Validated against the piece's own tile count so a
// malformed/forged value can't silently pollute the digest with bogus tile
// numbers; returns null (reject) rather than best-effort cleaning, since
// this is cheap client-computed data with no reason to ever be malformed.
function validMutedTiles(pieceId, s) {
  if (s === '' || s == null) return '';
  if (typeof s !== 'string' || s.length > MAX_MUTED_TILES_FIELD) return null;
  const count = STEM_COUNTS[pieceId];
  const parts = s.split(',');
  const seen = new Set();
  for (const p of parts) {
    if (!/^\d{1,2}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n >= count || seen.has(n)) return null;
    seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b).join(',');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/config' && request.method === 'GET') {
      const cfg = await readConfig(env);
      return corsJson(withNotationImageUrls(cfg));
    }

    // Analytics ping — public, no auth (same trust level/shape as any other
    // client telemetry beacon), write-only, tiny body. Body: { sessionId,
    // kind: 'start'|'heartbeat', pieceId, tempoPct, mutedTiles }. Sent via
    // navigator.sendBeacon so the request outlives page unload; a beacon
    // body arrives as text/plain (sendBeacon can't set a custom content
    // type), so this parses JSON regardless of what content-type the
    // request actually carries. Every field is validated and the row is
    // simply dropped (200, no error surfaced) on anything malformed —
    // there's no user waiting on this response and no reason to ever let a
    // bad ping break playback.
    if (url.pathname === '/api/track' && request.method === 'POST') {
      if (!env.ANALYTICS_DB) return corsJson({ ok: true }); // DB not yet bound in this deploy — no-op rather than error
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return corsJson({ ok: true });
      }
      const pieceId = body?.pieceId;
      const tempoPct = Number(body?.tempoPct);
      const kind = body?.kind;
      const mutedTiles = validMutedTiles(pieceId, body?.mutedTiles);
      if (
        !validSessionId(body?.sessionId) ||
        !ANALYTICS_KINDS.includes(kind) ||
        !KNOWN_MOSAIC_IDS.includes(pieceId) ||
        !ANALYTICS_TEMPOS.includes(tempoPct) ||
        mutedTiles === null
      ) {
        return corsJson({ ok: true }); // silently drop — see comment above
      }
      try {
        await env.ANALYTICS_DB.prepare(
          'INSERT INTO pings (session_id, ts, piece_id, tempo_pct, muted_tiles, kind) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(body.sessionId, Date.now(), pieceId, tempoPct, mutedTiles, kind).run();
      } catch {
        // Best-effort — a transient D1 hiccup should never surface to the player.
      }
      return corsJson({ ok: true });
    }

    if (url.pathname === '/api/admin/config' && request.method === 'POST') {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: 'Incorrect passphrase.' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: 'Invalid JSON body.' }, 400);
      }
      // Sep 7 2026 (real report: admin.html Save showing a bare "check your
      // connection" with no real cause): normalizeConfig()/KV .put() were
      // previously unguarded here, so any bug in either one surfaced as an
      // uncaught exception — Cloudflare's own generic error page, not JSON
      // — which admin.html then had no useful message to show. Wrapping the
      // actual write in try/catch means a real server-side failure comes
      // back as a normal JSON error response instead.
      try {
        // This route only ever carries order/metroOffsetMs/stemGainDb/
        // tileOrder from admin.html's main "Save & publish" bar — notation
        // overrides are written by their own dedicated routes below (each
        // upload/delete takes effect immediately, independent of this
        // button) — so merge the existing notationOverrides back in rather
        // than letting a Save here revert to whatever this request body
        // happens to carry (admin.html's `state` never populates that key).
        const existing = await readConfig(env);
        const cfg = normalizeConfig({ ...body, notationOverrides: existing.notationOverrides });
        await writeConfig(env, cfg);
        return corsJson(withNotationImageUrls(cfg));
      } catch (e) {
        return corsJson({ error: 'Server error while saving: ' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }

    // Upload (or replace) one per-tile notation image variant. Body:
    // { pieceId, tileIndex, bars: 'all'|number[], imageBase64, variantId? }.
    // variantId is optional — omit it to add a new variant; the server also
    // auto-replaces an existing variant with the SAME bars (so re-uploading
    // "the bars 6/12 image" or "the base image" again just updates it in
    // place instead of piling up duplicates) unless a specific variantId is
    // given (used by admin.html's own "Replace" button on one exact row).
    if (url.pathname === '/api/admin/notation-upload' && request.method === 'POST') {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: 'Incorrect passphrase.' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: 'Invalid JSON body.' }, 400);
      }
      const pieceId = body?.pieceId;
      const tileIndex = Number(body?.tileIndex);
      if (!KNOWN_MOSAIC_IDS.includes(pieceId)) return corsJson({ error: 'Unknown piece.' }, 400);
      if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= STEM_COUNTS[pieceId]) {
        return corsJson({ error: 'Invalid tile index.' }, 400);
      }
      const bars = validateBars(body?.bars);
      if (bars === null) {
        return corsJson({ error: "bars must be 'all' or a non-empty list of bar numbers." }, 400);
      }
      const bytes = decodeBase64Image(body?.imageBase64);
      if (!bytes || !bytes.length) return corsJson({ error: 'Missing or unreadable image data.' }, 400);
      if (bytes.length > MAX_NOTATION_IMAGE_BYTES) {
        return corsJson({ error: `Image too large — max ${Math.round(MAX_NOTATION_IMAGE_BYTES / 1024 / 1024)}MB.` }, 400);
      }
      if (!looksLikePng(bytes)) {
        return corsJson({ error: 'File does not look like a valid PNG.' }, 400);
      }

      try {
        const cfg = await readConfig(env);
        if (!cfg.notationOverrides[pieceId]) cfg.notationOverrides[pieceId] = {};
        const existingVariants = cfg.notationOverrides[pieceId][tileIndex] || [];

        let variantId = (typeof body?.variantId === 'string' && /^[a-z0-9]{4,32}$/i.test(body.variantId))
          ? body.variantId
          : null;
        if (variantId && !existingVariants.some(v => v.id === variantId)) variantId = null; // unknown id — treat as "new"
        if (!variantId) {
          const matchingBars = existingVariants.find(v => sameBars(v.bars, bars));
          variantId = matchingBars ? matchingBars.id : randomVariantId();
        }

        const updatedAt = Date.now();
        const nextVariants = existingVariants.filter(v => v.id !== variantId);
        nextVariants.push({ id: variantId, bars, updatedAt });
        cfg.notationOverrides[pieceId][tileIndex] = nextVariants;

        await env.ADMIN_CONFIG.put(notationImgKey(pieceId, tileIndex, variantId), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        await writeConfig(env, cfg);
        return corsJson({ ...withNotationImageUrls(cfg), savedVariantId: variantId });
      } catch (e) {
        return corsJson({ error: 'Server error while saving: ' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }

    // Remove one per-tile notation image variant. Body: { pieceId, tileIndex, variantId }.
    if (url.pathname === '/api/admin/notation-delete' && request.method === 'POST') {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: 'Incorrect passphrase.' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: 'Invalid JSON body.' }, 400);
      }
      const pieceId = body?.pieceId;
      const tileIndex = Number(body?.tileIndex);
      const variantId = body?.variantId;
      if (!KNOWN_MOSAIC_IDS.includes(pieceId)) return corsJson({ error: 'Unknown piece.' }, 400);
      if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= STEM_COUNTS[pieceId]) {
        return corsJson({ error: 'Invalid tile index.' }, 400);
      }
      if (typeof variantId !== 'string' || !variantId) return corsJson({ error: 'Missing variantId.' }, 400);

      try {
        const cfg = await readConfig(env);
        const existingVariants = (cfg.notationOverrides[pieceId] && cfg.notationOverrides[pieceId][tileIndex]) || [];
        cfg.notationOverrides[pieceId][tileIndex] = existingVariants.filter(v => v.id !== variantId);
        if (!cfg.notationOverrides[pieceId][tileIndex].length) delete cfg.notationOverrides[pieceId][tileIndex];
        await env.ADMIN_CONFIG.delete(notationImgKey(pieceId, tileIndex, variantId));
        await writeConfig(env, cfg);
        return corsJson(withNotationImageUrls(cfg));
      } catch (e) {
        return corsJson({ error: 'Server error while deleting: ' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }

    // Usage digest for admin.html's Usage page — admin-passphrase gated,
    // same as every other /api/admin/* route. Does the aggregation in SQL
    // (cheap, small volumes) except mute-frequency, which needs the raw
    // muted_tiles strings split apart — done here in JS rather than a
    // recursive-CTE query, simplest for the data volumes this will ever see.
    if (url.pathname === '/api/admin/analytics' && request.method === 'GET') {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: 'Incorrect passphrase.' }, 401);
      }
      if (!env.ANALYTICS_DB) {
        return corsJson({ error: 'Analytics database not bound yet — deploy after adding the D1 binding.' }, 500);
      }
      try {
        const db = env.ANALYTICS_DB;
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

        const totalsQ = db.prepare(
          `SELECT COUNT(DISTINCT session_id) AS allTime,
                  SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS recentPings
           FROM pings WHERE kind = 'start'`
        ).bind(thirtyDaysAgo);
        const recentSessionsQ = db.prepare(
          `SELECT COUNT(DISTINCT session_id) AS recent FROM pings WHERE kind = 'start' AND ts >= ?`
        ).bind(thirtyDaysAgo);
        const perPieceQ = db.prepare(
          `SELECT piece_id,
                  COUNT(DISTINCT session_id) AS sessions,
                  SUM(CASE WHEN kind = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeats
           FROM pings GROUP BY piece_id`
        );
        const perTempoQ = db.prepare(
          `SELECT piece_id, tempo_pct, COUNT(*) AS heartbeats
           FROM pings WHERE kind = 'heartbeat' GROUP BY piece_id, tempo_pct`
        );
        const muteRowsQ = db.prepare(
          `SELECT piece_id, muted_tiles FROM pings WHERE kind = 'heartbeat' AND muted_tiles != ''`
        );
        const lastActivityQ = db.prepare(`SELECT MAX(ts) AS lastTs FROM pings`);

        const [totals, recentSessions, perPiece, perTempo, muteRows, lastActivity] = await Promise.all([
          totalsQ.first(), recentSessionsQ.first(), perPieceQ.all(), perTempoQ.all(), muteRowsQ.all(), lastActivityQ.first(),
        ]);

        const pieces = {};
        for (const id of KNOWN_MOSAIC_IDS) {
          pieces[id] = { sessions: 0, heartbeats: 0, minutes: 0, tempoBreakdown: {}, muteFrequency: {} };
          for (const t of ANALYTICS_TEMPOS) pieces[id].tempoBreakdown[t] = 0;
        }
        for (const row of perPiece.results || []) {
          if (!pieces[row.piece_id]) continue;
          pieces[row.piece_id].sessions = row.sessions || 0;
          pieces[row.piece_id].heartbeats = row.heartbeats || 0;
          pieces[row.piece_id].minutes = Math.round(((row.heartbeats || 0) * ANALYTICS_HEARTBEAT_SECONDS) / 60 * 10) / 10;
        }
        for (const row of perTempo.results || []) {
          if (!pieces[row.piece_id]) continue;
          pieces[row.piece_id].tempoBreakdown[row.tempo_pct] = row.heartbeats || 0;
        }
        for (const row of (muteRows.results || [])) {
          const p = pieces[row.piece_id];
          if (!p) continue;
          for (const tileStr of row.muted_tiles.split(',')) {
            if (tileStr === '') continue;
            p.muteFrequency[tileStr] = (p.muteFrequency[tileStr] || 0) + 1;
          }
        }

        return corsJson({
          totalConnections: totals?.allTime || 0,
          connections30d: recentSessions?.recent || 0,
          lastActivityAt: lastActivity?.lastTs || null,
          heartbeatSeconds: ANALYTICS_HEARTBEAT_SECONDS,
          pieces,
          generatedAt: Date.now(),
        });
      } catch (e) {
        return corsJson({ error: 'Server error while reading analytics: ' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }

    // Serves one uploaded notation PNG. Public, no auth (same trust level as
    // any other static asset — poster art, the committed notation strips,
    // etc.) — GET-only, path-only lookup, nothing here ever reads request
    // headers/body beyond the URL. Aggressively cacheable BECAUSE the `v=`
    // query is the variant's own updatedAt (see withNotationImageUrls()):
    // replacing the image changes the URL, so this can never serve stale
    // bytes under a URL a browser/edge cache already has.
    const imgMatch = url.pathname.match(/^\/api\/notation-image\/([a-z]+)\/(\d+)\/([a-z0-9]+)$/i);
    if (imgMatch && request.method === 'GET') {
      const [, pieceId, tileIndexStr, variantId] = imgMatch;
      if (!KNOWN_MOSAIC_IDS.includes(pieceId)) return new Response('Not found', { status: 404 });
      const bytes = await env.ADMIN_CONFIG.get(notationImgKey(pieceId, tileIndexStr, variantId), { type: 'arrayBuffer' });
      if (!bytes) return new Response('Not found', { status: 404 });
      const hasVersion = url.searchParams.has('v');
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': hasVersion ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
        },
      });
    }

    // Everything else (the player, the admin page, notation/audio/poster
    // assets, the JS engine files, etc.) is served exactly as it was before
    // this Worker existed.
    return env.ASSETS.fetch(request);
  },
};
