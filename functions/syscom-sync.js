import { requireAuth, resp } from "../lib/session.js";
import * as settings from "../lib/settings.js";
import { parseCsv, mapCsvRows, validateSyscomUrl, fetchSyscomCsv, saveCatalogParts } from "../lib/syscom-csv.js";

async function ensureMeta(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS gaso_syscom_sync_meta (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    total INTEGER NOT NULL DEFAULT 0,
    parts INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT
  )`).run();
}

async function setMeta(db, status, message, total = 0, parts = 0, finished = false) {
  await db.prepare(`INSERT INTO gaso_syscom_sync_meta (id, status, total, parts, message, started_at, finished_at)
    VALUES (1, ?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, ?5)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      total = excluded.total,
      parts = excluded.parts,
      message = excluded.message,
      finished_at = excluded.finished_at,
      started_at = CASE WHEN excluded.status = 'running' THEN CURRENT_TIMESTAMP ELSE gaso_syscom_sync_meta.started_at END`)
    .bind(status, total, parts, message, finished ? new Date().toISOString() : null)
    .run();
}

async function getMeta(db) {
  try {
    await ensureMeta(db);
    const row = await db.prepare("SELECT status, total, parts, message, started_at, finished_at FROM gaso_syscom_sync_meta WHERE id = 1").first();
    return row || { status: "idle", total: 0, parts: 0, message: "", started_at: null, finished_at: null };
  } catch (e) {
    return { status: "idle", total: 0, parts: 0, message: "", started_at: null, finished_at: null };
  }
}

async function runSync(env, urlOverride) {
  const db = env.DB;
  await ensureMeta(db);
  await setMeta(db, "running", "Descargando CSV de Syscom…", 0, 0, false);
  try {
    await settings.load(db, true, env.SESSION_SECRET || "", env);
    const url = String(urlOverride || settings.get("SYSCOM_CSV_URL") || env.SYSCOM_CSV_URL || "").trim();
    const verr = validateSyscomUrl(url);
    if (verr) {
      await setMeta(db, "error", verr, 0, 0, true);
      return;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
    let csvText;
    try {
      await setMeta(db, "running", "Descargando reporte CSV (puede tardar)…", 0, 0, false);
      csvText = await fetchSyscomCsv(url, ctl.signal);
    } finally {
      clearTimeout(timer);
    }

    await setMeta(db, "running", "Procesando CSV…", 0, 0, false);
    const rows = parseCsv(csvText);
    const products = mapCsvRows(rows);
    if (!products.length) {
      await setMeta(db, "error", "No se detectaron productos con precio en el CSV. Revisa el formato SYSCOM del reporte.", 0, 0, true);
      return;
    }

    await setMeta(db, "running", "Guardando " + products.length + " productos en D1…", products.length, 0, false);
    const saved = await saveCatalogParts(db, "syscom", products);
    await setMeta(
      db,
      "ok",
      "Syscom sincronizado: " + saved.total.toLocaleString("es-MX") + " productos.",
      saved.total,
      saved.parts,
      true
    );
  } catch (e) {
    const msg = e && e.name === "AbortError"
      ? "Tiempo agotado al descargar Syscom. Reintenta (límite 1 descarga/hora en Syscom)."
      : ("Syscom: " + (e && e.message ? e.message : String(e)));
    try { await setMeta(db, "error", msg.slice(0, 400), 0, 0, true); } catch (e2) { /* ignore */ }
  }
}

export async function onRequestGet(context) {
  const headers = {};
  context.request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, context.env.SESSION_SECRET || "", context.env);
  if (auth.error) return auth.error;
  const meta = await getMeta(context.env.DB);
  return resp(200, {
    status: true,
    state: meta.status || "idle",
    total: meta.total || 0,
    parts: meta.parts || 0,
    message: meta.message || "",
    startedAt: meta.started_at,
    finishedAt: meta.finished_at,
    hasUrl: !!(await (async () => {
      await settings.load(context.env.DB, false, context.env.SESSION_SECRET || "", context.env);
      return settings.get("SYSCOM_CSV_URL") || context.env.SYSCOM_CSV_URL;
    })())
  });
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;
  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "", env);
  if (auth.error) return auth.error;
  if (auth.session.r !== "SUPERADMIN") {
    return resp(403, { status: false, message: "Solo el superusuario puede sincronizar Syscom." });
  }

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }

  await settings.load(env.DB, true, env.SESSION_SECRET || "", env);

  // Guardar enlace (cifrado) si viene en el body
  if (body.url) {
    const verr = validateSyscomUrl(body.url);
    if (verr) return resp(400, { status: false, message: verr });
    await settings.set("SYSCOM_CSV_URL", String(body.url).trim(), env.DB, env.SESSION_SECRET || "");
  }

  if (body.op === "save-url") {
    if (!body.url) return resp(400, { status: false, message: "Pega el enlace de descarga automática de Syscom." });
    return resp(200, { status: true, message: "Enlace Syscom guardado." });
  }

  const url = String(body.url || settings.get("SYSCOM_CSV_URL") || env.SYSCOM_CSV_URL || "").trim();
  if (!url) {
    return resp(400, {
      status: false,
      message: "Falta el enlace CSV. Cópialo en Syscom → Enlace de descarga automática y pégalo aquí."
    });
  }

  await ensureMeta(env.DB);
  const meta = await getMeta(env.DB);
  if (meta.status === "running") {
    return resp(200, { status: true, started: false, message: "Ya hay una sincronización en curso." });
  }

  // Ejecutar en background para no cortar por timeout del cliente
  const task = runSync(env, url);
  if (context.waitUntil) context.waitUntil(task);
  else await task;

  return resp(200, { status: true, started: true, message: "Sincronización Syscom iniciada." });
}
