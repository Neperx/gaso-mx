import session from "../lib/session.js";
import settings from "../lib/settings.js";
import { slimList } from "../lib/tecno-handler.js";

const CHUNK = 1000;

async function ensure(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS gaso_tecno_meta (
    id INTEGER PRIMARY KEY, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS gaso_tecno_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL)`).run();
}

async function setMeta(db, status, message, total = 0, chunks = 0, finished = false) {
  await db.prepare(`INSERT INTO gaso_tecno_meta (id, status, total, chunks, message, started_at, finished_at)
    VALUES (1, ?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, ?5)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, total = excluded.total, chunks = excluded.chunks,
      message = excluded.message, finished_at = excluded.finished_at,
      started_at = CASE WHEN excluded.status = 'running' THEN CURRENT_TIMESTAMP ELSE gaso_tecno_meta.started_at END`)
    .bind(status, total, chunks, message, finished ? new Date().toISOString() : null).run();
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await session.requireAuth({ headers }, env.SESSION_SECRET || "", env);
  if (auth.error) return auth.error;

  const db = env.DB;
  try {
    await ensure(db);
    await setMeta(db, "running", "Descargando catálogo de Tecnosinergia...");
    await settings.load(db, true, env.SESSION_SECRET || "", env);
    const token = settings.get("TECNO_API_TOKEN") || env.TECNO_API_TOKEN || "";
    if (!token) {
      await setMeta(db, "error", "No hay variable TECNO_API_TOKEN en Cloudflare.", 0, 0, true);
      return new Response("ok");
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12 * 60 * 1000);
    let r, text;
    try {
      r = await fetch("https://api.tecnosinergia.info/v3/item/list", {
        method: "GET",
        headers: { Accept: "application/json", "Content-Type": "application/json", "api-token": token },
        signal: ctl.signal
      });
      text = await r.text();
    } finally {
      clearTimeout(timer);
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* no JSON */ }
    if (!parsed) {
      await setMeta(db, "error", "Tecnosinergia respondió HTTP " + r.status + " sin JSON válido: " + String(text).replace(/\s+/g, " ").slice(0, 160), 0, 0, true);
      return new Response("ok");
    }
    if (parsed.status === false) {
      await setMeta(db, "error", "Tecnosinergia: " + (parsed.message || parsed.messsage || "error") + " (código " + parsed.code + ")", 0, 0, true);
      return new Response("ok");
    }

    const items = slimList(parsed);
    if (!items || !items.length) {
      await setMeta(db, "error", "Tecnosinergia respondió, pero sin lista de productos.", 0, 0, true);
      return new Response("ok");
    }

    await db.prepare("DELETE FROM gaso_tecno_chunks").run();
    let n = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      await db.prepare("INSERT INTO gaso_tecno_chunks (idx, data) VALUES (?1, ?2)")
        .bind(n, JSON.stringify(items.slice(i, i + CHUNK)))
        .run();
      n++;
    }
    await setMeta(db, "ok", "Catálogo guardado.", items.length, n, true);
  } catch (e) {
    try {
      await setMeta(
        db,
        "error",
        (e.name === "AbortError"
          ? "Tecnosinergia tardó más de 12 minutos en responder."
          : String(e.message || e)
        ).slice(0, 300),
        0,
        0,
        true
      );
    } catch (e2) { /* sin DB */ }
  }
  return new Response("ok");
}
