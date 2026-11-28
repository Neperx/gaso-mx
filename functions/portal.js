import { resp, clientIp } from "../lib/session.js";

const pinAttempts = new Map();
const MAX_PIN_FAILS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEqHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeClientKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sanitizeProjectForClient(p) {
  if (!p || p.status === "Cancelado") return null;
  const items = (Array.isArray(p.items) ? p.items : []).map((it, idx) => ({
    n: idx + 1,
    title: String(it.title || ""),
    desc: String(it.desc || ""),
    qty: Number(it.qty) || 0,
    unit: String(it.unit || "Serv."),
    unitPrice: Number(it.unitPrice) || 0,
    total: Number(it.total) || ((Number(it.qty) || 0) * (Number(it.unitPrice) || 0))
  }));
  const payments = (Array.isArray(p.payments) ? p.payments : []).map((pay) => ({
    date: String(pay.date || ""),
    concept: String(pay.concept || "Abono"),
    amount: Number(pay.amount) || 0
  }));
  return {
    id: String(p.id || ""),
    folioNum: parseInt(p.folioNum, 10) || 0,
    date: String(p.date || ""),
    clientName: String(p.clientName || ""),
    concept: String(p.concept || ""),
    status: String(p.status || ""),
    prevFolioRef: p.prevFolioRef ? parseInt(p.prevFolioRef, 10) : null,
    prevBalanceAmount: Number(p.prevBalanceAmount) || 0,
    closedToFolio: p.closedToFolio ? parseInt(p.closedToFolio, 10) : null,
    carriedOverBalance: Number(p.carriedOverBalance) || 0,
    useIva: !!p.useIva,
    useResico: !!p.useResico,
    subtotalAmount: Number(p.subtotalAmount) || 0,
    ivaAmount: Number(p.ivaAmount) || 0,
    resicoAmount: Number(p.resicoAmount) || 0,
    totalAmount: Number(p.totalAmount) || 0,
    paidAmount: Number(p.paidAmount) || 0,
    balanceAmount: Number(p.balanceAmount) || 0,
    mercadopagoUrl: String(p.mercadopagoUrl || ""),
    items,
    payments
  };
}

async function ensurePortalTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_portal_links (
      token TEXT PRIMARY KEY,
      client_key TEXT NOT NULL,
      client_name TEXT NOT NULL,
      pin_hash TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_gaso_portal_client ON gaso_portal_links (client_key)`)
  ]);
}

async function loadClientProjects(db, clientKey) {
  const { results } = await db
    .prepare("SELECT data FROM gaso_projects WHERE LOWER(TRIM(client_name)) = ?1 ORDER BY folio_num DESC")
    .bind(clientKey)
    .all();

  const list = [];
  for (const row of (results || [])) {
    try {
      const parsed = JSON.parse(row.data);
      const clean = sanitizeProjectForClient(parsed);
      if (clean) list.push(clean);
    } catch (e) {}
  }
  // Si el nombre en JSON tenía múltiples espacios internos, validar normalizado
  if (!list.length) {
    const { results: allRows } = await db.prepare("SELECT data FROM gaso_projects ORDER BY folio_num DESC").all();
    for (const row of (allRows || [])) {
      try {
        const parsed = JSON.parse(row.data);
        if (normalizeClientKey(parsed && parsed.clientName) === clientKey) {
          const clean = sanitizeProjectForClient(parsed);
          if (clean) list.push(clean);
        }
      } catch (e) {}
    }
  }
  return list;
}

async function lookupToken(db, token) {
  if (!token || token.length < 16) return null;
  const { results } = await db
    .prepare("SELECT token, client_key, client_name, pin_hash, active, expires_at FROM gaso_portal_links WHERE token = ?1")
    .bind(token)
    .all();
  if (!results || !results.length) return null;
  const link = results[0];
  if (Number(link.active) !== 1) return null;
  if (Number(link.expires_at) > 0 && Date.now() > Number(link.expires_at)) return null;
  return link;
}

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    if (!db) return resp(500, { ok: false, message: "Base de datos no disponible." });
    await ensurePortalTables(db);

    const url = new URL(context.request.url);
    const token = (url.searchParams.get("t") || "").trim();
    const link = await lookupToken(db, token);
    if (!link) {
      return resp(404, { ok: false, message: "Este enlace no es válido, ha expirado o fue revocado por GASO Ingeniería." });
    }

    const requiresPin = !!(link.pin_hash && link.pin_hash.length > 0);
    if (requiresPin) {
      return resp(200, {
        ok: true,
        locked: true,
        requiresPin: true,
        clientName: link.client_name
      });
    }

    const projects = await loadClientProjects(db, link.client_key);
    return resp(200, {
      ok: true,
      locked: false,
      requiresPin: false,
      clientName: link.client_name,
      projects
    });
  } catch (e) {
    return resp(500, { ok: false, message: "Error al consultar estado de cuenta." });
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return resp(500, { ok: false, message: "Base de datos no disponible." });
    await ensurePortalTables(db);

    let body = {};
    try { body = await context.request.json(); } catch (e) { return resp(400, { ok: false, message: "Solicitud inválida." }); }

    const token = String(body.token || "").trim();
    const pin = String(body.pin || "").trim();
    const link = await lookupToken(db, token);
    if (!link) {
      return resp(404, { ok: false, message: "Este enlace no es válido, ha expirado o fue revocado." });
    }

    if (link.pin_hash) {
      const headers = {};
      context.request.headers.forEach((v, k) => { headers[k] = v; });
      const rlKey = clientIp({ headers }) + ":" + token.slice(0, 12);
      const now = Date.now();
      const rec = pinAttempts.get(rlKey);
      if (rec && rec.until > now) {
        const mins = Math.ceil((rec.until - now) / 60000);
        return resp(429, { ok: false, message: `Demasiados intentos fallidos. Espera ${mins} minutos o solicita un nuevo enlace.` });
      }

      const candidateHash = await sha256Hex(`${token}:${pin}`);
      const ok = await constantTimeEqHex(candidateHash, link.pin_hash);
      if (!ok) {
        const fails = (rec && rec.resetAt > now ? rec.fails : 0) + 1;
        const left = Math.max(0, MAX_PIN_FAILS - fails);
        pinAttempts.set(rlKey, {
          fails,
          resetAt: now + PIN_WINDOW_MS,
          until: fails >= MAX_PIN_FAILS ? now + PIN_WINDOW_MS : 0
        });
        return resp(401, {
          ok: false,
          message: left > 0 ? `NIP incorrecto. Te quedan ${left} intentos.` : "Demasiados intentos fallidos. Acceso bloqueado 15 minutos."
        });
      }
      pinAttempts.delete(rlKey);
    }

    const projects = await loadClientProjects(db, link.client_key);
    return resp(200, {
      ok: true,
      locked: false,
      clientName: link.client_name,
      projects
    });
  } catch (e) {
    return resp(500, { ok: false, message: "Error al verificar acceso." });
  }
}
