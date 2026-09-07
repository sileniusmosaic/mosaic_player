// Admin-configurable settings backend (Sep 2026).
//
// This Worker used to not exist at all — the site was pure static assets
// (see wrangler.jsonc's "assets" block). Two small API routes are added here
// so the admin console (admin.html) can publish changes — mosaic play order,
// and a per-piece metronome click "nudge" in milliseconds — that take effect
// immediately for every visitor, without a new deploy each time. Every other
// request just falls through to the static assets exactly as before.
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

const KNOWN_MOSAIC_IDS = ['flipswing', 'abakua', 'congo'];

const DEFAULT_CONFIG = {
  order: KNOWN_MOSAIC_IDS.slice(),
  metroOffsetMs: { flipswing: 0, abakua: 0, congo: 0 },
};

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
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
  return cfg;
}

async function readConfig(env) {
  const raw = await env.ADMIN_CONFIG.get('config', { type: 'json' });
  return normalizeConfig(raw || DEFAULT_CONFIG);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/config' && request.method === 'GET') {
      const cfg = await readConfig(env);
      return corsJson(cfg);
    }

    if (url.pathname === '/api/admin/config' && request.method === 'POST') {
      const passphrase = request.headers.get('x-admin-passphrase') || '';
      // env.ADMIN_PASSPHRASE not yet set (secret never configured) → refuse
      // every write rather than silently accepting an empty passphrase.
      if (!env.ADMIN_PASSPHRASE || passphrase !== env.ADMIN_PASSPHRASE) {
        return corsJson({ error: 'Incorrect passphrase.' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: 'Invalid JSON body.' }, 400);
      }
      const cfg = normalizeConfig(body);
      await env.ADMIN_CONFIG.put('config', JSON.stringify(cfg));
      return corsJson(cfg);
    }

    // Everything else (the player, the admin page, notation/audio/poster
    // assets, the JS engine files, etc.) is served exactly as it was before
    // this Worker existed.
    return env.ASSETS.fetch(request);
  },
};
