var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var KNOWN_MOSAIC_IDS = ["flipswing", "abakua", "congo"];
var STEM_COUNTS = { flipswing: 8, abakua: 8, congo: 8 };
var STEM_GAIN_DB_MIN = -18;
var STEM_GAIN_DB_MAX = 18;
function defaultStemGainDb() {
  const out = {};
  for (const id of KNOWN_MOSAIC_IDS) out[id] = new Array(STEM_COUNTS[id]).fill(0);
  return out;
}
__name(defaultStemGainDb, "defaultStemGainDb");
function defaultTileOrder() {
  const out = {};
  for (const id of KNOWN_MOSAIC_IDS) out[id] = Array.from({ length: STEM_COUNTS[id] }, (_, i) => i);
  return out;
}
__name(defaultTileOrder, "defaultTileOrder");
var DEFAULT_CONFIG = {
  order: KNOWN_MOSAIC_IDS.slice(),
  metroOffsetMs: { flipswing: 0, abakua: 0, congo: 0 },
  stemGainDb: defaultStemGainDb(),
  tileOrder: defaultTileOrder()
};
function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
__name(corsJson, "corsJson");
function normalizeConfig(raw) {
  const cfg = { order: [], metroOffsetMs: {} };
  const rawOrder = Array.isArray(raw?.order) ? raw.order.filter((id) => KNOWN_MOSAIC_IDS.includes(id)) : [];
  cfg.order = rawOrder.concat(KNOWN_MOSAIC_IDS.filter((id) => !rawOrder.includes(id)));
  for (const id of KNOWN_MOSAIC_IDS) {
    const v = raw?.metroOffsetMs?.[id];
    cfg.metroOffsetMs[id] = typeof v === "number" && isFinite(v) ? Math.max(-500, Math.min(500, v)) : 0;
  }
  cfg.stemGainDb = {};
  for (const id of KNOWN_MOSAIC_IDS) {
    const count = STEM_COUNTS[id];
    const rawArr = Array.isArray(raw?.stemGainDb?.[id]) ? raw.stemGainDb[id] : [];
    cfg.stemGainDb[id] = Array.from({ length: count }, (_, i) => {
      const v = rawArr[i];
      if (typeof v !== "number" || !isFinite(v)) return 0;
      const clamped = Math.max(STEM_GAIN_DB_MIN, Math.min(STEM_GAIN_DB_MAX, v));
      return Math.round(clamped * 10) / 10;
    });
  }
  cfg.tileOrder = {};
  for (const id of KNOWN_MOSAIC_IDS) {
    const count = STEM_COUNTS[id];
    const rawArr = Array.isArray(raw?.tileOrder?.[id]) ? raw.tileOrder[id] : [];
    const seen = /* @__PURE__ */ new Set();
    const valid = [];
    for (const v of rawArr) {
      if (Number.isInteger(v) && v >= 0 && v < count && !seen.has(v)) {
        seen.add(v);
        valid.push(v);
      }
    }
    for (let i = 0; i < count; i++) if (!seen.has(i)) valid.push(i);
    cfg.tileOrder[id] = valid;
  }
  return cfg;
}
__name(normalizeConfig, "normalizeConfig");
async function readConfig(env) {
  const raw = await env.ADMIN_CONFIG.get("config", { type: "json" });
  return normalizeConfig(raw || DEFAULT_CONFIG);
}
__name(readConfig, "readConfig");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      const cfg = await readConfig(env);
      return corsJson(cfg);
    }
    if (url.pathname === "/api/admin/config" && request.method === "POST") {
      const passphrase = request.headers.get("x-admin-passphrase") || "";
      if (!env.ADMIN_PASSPHRASE || passphrase !== env.ADMIN_PASSPHRASE) {
        return corsJson({ error: "Incorrect passphrase." }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: "Invalid JSON body." }, 400);
      }
      try {
        const cfg = normalizeConfig(body);
        await env.ADMIN_CONFIG.put("config", JSON.stringify(cfg));
        return corsJson(cfg);
      } catch (e) {
        return corsJson({ error: "Server error while saving: " + (e && e.message ? e.message : String(e)) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
