var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var KNOWN_MOSAIC_IDS = ["flipswing", "abakua", "congo"];
var STEM_COUNTS = { flipswing: 8, abakua: 8, congo: 8 };
var STEM_GAIN_DB_MIN = -18;
var STEM_GAIN_DB_MAX = 18;
var MAX_NOTATION_IMAGE_BYTES = 8 * 1024 * 1024;
var MAX_BARS_PER_VARIANT = 200;
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
function defaultNotationOverrides() {
  const out = {};
  for (const id of KNOWN_MOSAIC_IDS) out[id] = {};
  return out;
}
__name(defaultNotationOverrides, "defaultNotationOverrides");
var DEFAULT_CONFIG = {
  order: KNOWN_MOSAIC_IDS.slice(),
  metroOffsetMs: { flipswing: 0, abakua: 0, congo: 0 },
  stemGainDb: defaultStemGainDb(),
  tileOrder: defaultTileOrder(),
  notationOverrides: defaultNotationOverrides()
};
function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
__name(corsJson, "corsJson");
function validateBars(bars) {
  if (bars === "all") return "all";
  if (!Array.isArray(bars) || bars.length === 0 || bars.length > MAX_BARS_PER_VARIANT) return null;
  const seen = /* @__PURE__ */ new Set();
  for (const v of bars) {
    if (!Number.isInteger(v) || v < 1 || v > 9999) return null;
    seen.add(v);
  }
  return Array.from(seen).sort((a, b) => a - b);
}
__name(validateBars, "validateBars");
function sameBars(a, b) {
  if (a === "all" || b === "all") return a === b;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
__name(sameBars, "sameBars");
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
  cfg.notationOverrides = {};
  for (const id of KNOWN_MOSAIC_IDS) {
    const count = STEM_COUNTS[id];
    const rawByTile = raw?.notationOverrides && typeof raw.notationOverrides === "object" ? raw.notationOverrides[id] : null;
    const byTile = {};
    if (rawByTile && typeof rawByTile === "object") {
      for (const key of Object.keys(rawByTile)) {
        const tileIndex = Number(key);
        if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= count) continue;
        const rawVariants = Array.isArray(rawByTile[key]) ? rawByTile[key] : [];
        const variants = [];
        for (const v of rawVariants) {
          if (!v || typeof v !== "object") continue;
          if (typeof v.id !== "string" || !/^[a-z0-9]{4,32}$/i.test(v.id)) continue;
          const bars = validateBars(v.bars);
          if (bars === null) continue;
          const updatedAt = typeof v.updatedAt === "number" && isFinite(v.updatedAt) ? v.updatedAt : Date.now();
          variants.push({ id: v.id, bars, updatedAt });
        }
        if (variants.length) byTile[tileIndex] = variants;
      }
    }
    cfg.notationOverrides[id] = byTile;
  }
  return cfg;
}
__name(normalizeConfig, "normalizeConfig");
function withNotationImageUrls(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const id of Object.keys(out.notationOverrides || {})) {
    const byTile = out.notationOverrides[id];
    for (const tileIndex of Object.keys(byTile)) {
      byTile[tileIndex] = byTile[tileIndex].map((v) => ({
        ...v,
        url: `/api/notation-image/${id}/${tileIndex}/${v.id}?v=${v.updatedAt}`
      }));
    }
  }
  return out;
}
__name(withNotationImageUrls, "withNotationImageUrls");
function notationImgKey(pieceId, tileIndex, variantId) {
  return `notation-img:${pieceId}:${tileIndex}:${variantId}`;
}
__name(notationImgKey, "notationImgKey");
function randomVariantId() {
  return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
__name(randomVariantId, "randomVariantId");
var PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
function looksLikePng(bytes) {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}
__name(looksLikePng, "looksLikePng");
function decodeBase64Image(input) {
  if (typeof input !== "string" || !input) return null;
  const comma = input.indexOf(",");
  const b64 = input.startsWith("data:") && comma >= 0 ? input.slice(comma + 1) : input;
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
__name(decodeBase64Image, "decodeBase64Image");
async function readConfig(env) {
  const raw = await env.ADMIN_CONFIG.get("config", { type: "json" });
  return normalizeConfig(raw || DEFAULT_CONFIG);
}
__name(readConfig, "readConfig");
async function writeConfig(env, cfg) {
  await env.ADMIN_CONFIG.put("config", JSON.stringify(cfg));
}
__name(writeConfig, "writeConfig");
function checkPassphrase(request, env) {
  const passphrase = request.headers.get("x-admin-passphrase") || "";
  return !!env.ADMIN_PASSPHRASE && passphrase === env.ADMIN_PASSPHRASE;
}
__name(checkPassphrase, "checkPassphrase");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      const cfg = await readConfig(env);
      return corsJson(withNotationImageUrls(cfg));
    }
    if (url.pathname === "/api/admin/config" && request.method === "POST") {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: "Incorrect passphrase." }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: "Invalid JSON body." }, 400);
      }
      try {
        const existing = await readConfig(env);
        const cfg = normalizeConfig({ ...body, notationOverrides: existing.notationOverrides });
        await writeConfig(env, cfg);
        return corsJson(withNotationImageUrls(cfg));
      } catch (e) {
        return corsJson({ error: "Server error while saving: " + (e && e.message ? e.message : String(e)) }, 500);
      }
    }
    if (url.pathname === "/api/admin/notation-upload" && request.method === "POST") {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: "Incorrect passphrase." }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: "Invalid JSON body." }, 400);
      }
      const pieceId = body?.pieceId;
      const tileIndex = Number(body?.tileIndex);
      if (!KNOWN_MOSAIC_IDS.includes(pieceId)) return corsJson({ error: "Unknown piece." }, 400);
      if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= STEM_COUNTS[pieceId]) {
        return corsJson({ error: "Invalid tile index." }, 400);
      }
      const bars = validateBars(body?.bars);
      if (bars === null) {
        return corsJson({ error: "bars must be 'all' or a non-empty list of bar numbers." }, 400);
      }
      const bytes = decodeBase64Image(body?.imageBase64);
      if (!bytes || !bytes.length) return corsJson({ error: "Missing or unreadable image data." }, 400);
      if (bytes.length > MAX_NOTATION_IMAGE_BYTES) {
        return corsJson({ error: `Image too large \u2014 max ${Math.round(MAX_NOTATION_IMAGE_BYTES / 1024 / 1024)}MB.` }, 400);
      }
      if (!looksLikePng(bytes)) {
        return corsJson({ error: "File does not look like a valid PNG." }, 400);
      }
      try {
        const cfg = await readConfig(env);
        if (!cfg.notationOverrides[pieceId]) cfg.notationOverrides[pieceId] = {};
        const existingVariants = cfg.notationOverrides[pieceId][tileIndex] || [];
        let variantId = typeof body?.variantId === "string" && /^[a-z0-9]{4,32}$/i.test(body.variantId) ? body.variantId : null;
        if (variantId && !existingVariants.some((v) => v.id === variantId)) variantId = null;
        if (!variantId) {
          const matchingBars = existingVariants.find((v) => sameBars(v.bars, bars));
          variantId = matchingBars ? matchingBars.id : randomVariantId();
        }
        const updatedAt = Date.now();
        const nextVariants = existingVariants.filter((v) => v.id !== variantId);
        nextVariants.push({ id: variantId, bars, updatedAt });
        cfg.notationOverrides[pieceId][tileIndex] = nextVariants;
        await env.ADMIN_CONFIG.put(notationImgKey(pieceId, tileIndex, variantId), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        await writeConfig(env, cfg);
        return corsJson({ ...withNotationImageUrls(cfg), savedVariantId: variantId });
      } catch (e) {
        return corsJson({ error: "Server error while saving: " + (e && e.message ? e.message : String(e)) }, 500);
      }
    }
    if (url.pathname === "/api/admin/notation-delete" && request.method === "POST") {
      if (!checkPassphrase(request, env)) {
        return corsJson({ error: "Incorrect passphrase." }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return corsJson({ error: "Invalid JSON body." }, 400);
      }
      const pieceId = body?.pieceId;
      const tileIndex = Number(body?.tileIndex);
      const variantId = body?.variantId;
      if (!KNOWN_MOSAIC_IDS.includes(pieceId)) return corsJson({ error: "Unknown piece." }, 400);
      if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= STEM_COUNTS[pieceId]) {
        return corsJson({ error: "Invalid tile index." }, 400);
      }
      if (typeof variantId !== "string" || !variantId) return corsJson({ error: "Missing variantId." }, 400);
      try {
        const cfg = await readConfig(env);
        const existingVariants = cfg.notationOverrides[pieceId] && cfg.notationOverrides[pieceId][tileIndex] || [];
        cfg.notationOverrides[pieceId][tileIndex] = existingVariants.filter((v) => v.id !== variantId);
        if (!cfg.notationOverrides[pieceId][tileIndex].length) delete cfg.notationOverrides[pieceId][tileIndex];
        await env.ADMIN_CONFIG.delete(notationImgKey(pieceId, tileIndex, variantId));
        await writeConfig(env, cfg);
        return corsJson(withNotationImageUrls(cfg));
      } catch (e) {
        return corsJson({ error: "Server error while deleting: " + (e && e.message ? e.message : String(e)) }, 500);
      }
    }
    const imgMatch = url.pathname.match(/^\/api\/notation-image\/([a-z]+)\/(\d+)\/([a-z0-9]+)$/i);
    if (imgMatch && request.method === "GET") {
      const [, pieceId, tileIndexStr, variantId] = imgMatch;
      if (!KNOWN_MOSAIC_IDS.includes(pieceId)) return new Response("Not found", { status: 404 });
      const bytes = await env.ADMIN_CONFIG.get(notationImgKey(pieceId, tileIndexStr, variantId), { type: "arrayBuffer" });
      if (!bytes) return new Response("Not found", { status: 404 });
      const hasVersion = url.searchParams.has("v");
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control": hasVersion ? "public, max-age=31536000, immutable" : "public, max-age=60"
        }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
