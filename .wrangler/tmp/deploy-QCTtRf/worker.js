var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var KNOWN_MOSAIC_IDS = ["flipswing", "abakua", "congo"];
var DEFAULT_CONFIG = {
  order: KNOWN_MOSAIC_IDS.slice(),
  metroOffsetMs: { flipswing: 0, abakua: 0, congo: 0 }
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
      const cfg = normalizeConfig(body);
      await env.ADMIN_CONFIG.put("config", JSON.stringify(cfg));
      return corsJson(cfg);
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
