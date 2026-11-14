/**
 * Sincronización diaria Syscom + Tecnosinergia + tipo de cambio.
 * Auth: Authorization: Bearer <CRON_SECRET>  OR  sesión SUPERADMIN.
 */
import { requireAuth, resp } from "../lib/session.js";
import * as settings from "../lib/settings.js";
import { ensureFreshFx } from "../lib/fx.js";
import { parseCsv, mapCsvRows, fetchSyscomCsv, saveCatalogParts } from "../lib/syscom-csv.js";
import { slimList } from "../lib/tecno-handler.js";

async function authCronOrAdmin(request, env) {
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cron = env.CRON_SECRET || "";
  if (cron && bearer && bearer === cron) return { ok: true, via: "cron" };

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "", env);
  if (auth.error) return { ok: false, error: auth.error };
  if (auth.session.r !== "SUPERADMIN") {
    return { ok: false, error: resp(403, { status: false, message: "Solo SUPERADMIN o CRON_SECRET." }) };
  }
  return { ok: true, via: "admin", session: auth.session };
}

async function syncSyscom(env) {
  await settings.load(env.DB, true, env.SESSION_SECRET || "", env);
  const url = settings.get("SYSCOM_CSV_URL") || env.SYSCOM_CSV_URL || "";
  if (!url) return { ok: false, message: "Sin SYSCOM_CSV_URL" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
  try {
    const csv = await fetchSyscomCsv(url, ctl.signal);
    const products = mapCsvRows(parseCsv(csv));
    if (!products.length) return { ok: false, message: "CSV Syscom sin productos con precio" };
    const saved = await saveCatalogParts(env.DB, "syscom", products);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gaso_syscom_sync_meta (
      id INTEGER PRIMARY KEY, status TEXT, total INTEGER, parts INTEGER, message TEXT, started_at TEXT, finished_at TEXT
    )`).run();
    await env.DB.prepare(`INSERT INTO gaso_syscom_sync_meta (id, status, total, parts, message, started_at, finished_at)
      VALUES (1,'ok',?1,?2,?3,CURRENT_TIMESTAMP,?4)
      ON CONFLICT(id) DO UPDATE SET status='ok', total=excluded.total, parts=excluded.parts, message=excluded.message, finished_at=excluded.finished_at`)
      .bind(saved.total, saved.parts, "Cron Syscom OK", new Date().toISOString()).run();
    return { ok: true, total: saved.total };
  } finally {
    clearTimeout(t);
  }
}

async function syncTecno(env) {
  await settings.load(env.DB, true, env.SESSION_SECRET || "", env);
  const token = settings.get("TECNO_API_TOKEN") || env.TECNO_API_TOKEN || "";
  if (!token) return { ok: false, message: "Sin TECNO_API_TOKEN" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12 * 60 * 1000);
  try {
    const r = await fetch("https://api.tecnosinergia.info/v3/item/list", {
      method: "GET",
      headers: { Accept: "application/json", "Content-Type": "application/json", "api-token": token },
      signal: ctl.signal
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* ignore */ }
    if (!parsed || parsed.status === false) {
      return { ok: false, message: "Tecnosinergia: " + ((parsed && (parsed.message || parsed.messsage)) || ("HTTP " + r.status)) };
    }
    const items = slimList(parsed);
    if (!items.length) return { ok: false, message: "Tecnosinergia vacío" };
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gaso_tecno_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gaso_tecno_meta (
      id INTEGER PRIMARY KEY, status TEXT, total INTEGER, chunks INTEGER, message TEXT, started_at TEXT, finished_at TEXT
    )`).run();
    await env.DB.prepare("DELETE FROM gaso_tecno_chunks").run();
    const CHUNK = 1000;
    let n = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      await env.DB.prepare("INSERT INTO gaso_tecno_chunks (idx, data) VALUES (?1, ?2)")
        .bind(n, JSON.stringify(items.slice(i, i + CHUNK))).run();
      n++;
    }
    await env.DB.prepare(`INSERT INTO gaso_tecno_meta (id, status, total, chunks, message, started_at, finished_at)
      VALUES (1,'ok',?1,?2,?3,CURRENT_TIMESTAMP,?4)
      ON CONFLICT(id) DO UPDATE SET status='ok', total=excluded.total, chunks=excluded.chunks, message=excluded.message, finished_at=excluded.finished_at`)
      .bind(items.length, n, "Cron Tecno OK", new Date().toISOString()).run();
    return { ok: true, total: items.length };
  } finally {
    clearTimeout(t);
  }
}

async function runAll(env) {
  const out = { fx: null, syscom: null, tecno: null, at: new Date().toISOString() };
  try { out.fx = await ensureFreshFx(env.DB, true); }
  catch (e) { out.fx = { ok: false, message: e.message || String(e) }; }
  try { out.syscom = await syncSyscom(env); }
  catch (e) { out.syscom = { ok: false, message: e.message || String(e) }; }
  try { out.tecno = await syncTecno(env); }
  catch (e) { out.tecno = { ok: false, message: e.message || String(e) }; }
  return out;
}

export async function onRequestPost(context) {
  const gate = await authCronOrAdmin(context.request, context.env);
  if (!gate.ok) return gate.error;

  const url = new URL(context.request.url);
  const asyncMode = url.searchParams.get("async") !== "0";

  if (asyncMode && context.waitUntil) {
    context.waitUntil(runAll(context.env));
    return resp(200, { status: true, started: true, via: gate.via, message: "Sincronización diaria iniciada (FX + Syscom + Tecnosinergia)." });
  }
  const result = await runAll(context.env);
  return resp(200, { status: true, started: false, via: gate.via, result });
}

export async function onRequestGet(context) {
  // Estado rápido (sesión requerida)
  const headers = {};
  context.request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, context.env.SESSION_SECRET || "", context.env);
  if (auth.error) return auth.error;
  let sys = {}, tec = {}, fx = null;
  try {
    sys = await context.env.DB.prepare("SELECT status, total, message, finished_at FROM gaso_syscom_sync_meta WHERE id=1").first() || {};
  } catch (e) { /* ignore */ }
  try {
    tec = await context.env.DB.prepare("SELECT status, total, message, finished_at FROM gaso_tecno_meta WHERE id=1").first() || {};
  } catch (e) { /* ignore */ }
  try {
    const { loadFx } = await import("../lib/fx.js");
    fx = await loadFx(context.env.DB);
  } catch (e) { /* ignore */ }
  return resp(200, {
    status: true,
    fx,
    syscom: { state: sys.status, total: sys.total, message: sys.message, finishedAt: sys.finished_at },
    tecno: { state: tec.status, total: tec.total, message: tec.message, finishedAt: tec.finished_at }
  });
}
