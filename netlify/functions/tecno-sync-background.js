// Descarga el catálogo completo de Tecnosinergia en segundo plano (hasta 15 min) y lo guarda en la base de datos.
// Se invoca desde ⚙️ Configuración; responde 202 al instante y la página consulta el avance en /tecno-catalog.
import { getDatabase } from "@netlify/database";
import session from "../lib/session.js";
import settings from "../lib/settings.js";
import tecno from "../lib/tecno-handler.js";

const CHUNK = 1000;

async function ensure(db) {
  await db.sql`CREATE TABLE IF NOT EXISTS gaso_tecno_meta (
    id INT PRIMARY KEY, status TEXT NOT NULL, total INT NOT NULL DEFAULT 0, chunks INT NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '', started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)`;
  await db.sql`CREATE TABLE IF NOT EXISTS gaso_tecno_chunks (idx INT PRIMARY KEY, data TEXT NOT NULL)`;
}

async function setMeta(db, status, message, total = 0, chunks = 0, finished = false) {
  await db.sql`INSERT INTO gaso_tecno_meta (id, status, total, chunks, message, started_at, finished_at)
    VALUES (1, ${status}, ${total}, ${chunks}, ${message}, NOW(), ${finished ? new Date().toISOString() : null})
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, total = EXCLUDED.total, chunks = EXCLUDED.chunks,
      message = EXCLUDED.message, finished_at = EXCLUDED.finished_at,
      started_at = CASE WHEN EXCLUDED.status = 'running' THEN NOW() ELSE gaso_tecno_meta.started_at END`;
}

export default async (req) => {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const auth = session.requireAuth({ headers, httpMethod: req.method });
  if (auth.error) return new Response(auth.error.body, { status: auth.error.statusCode });

  const db = getDatabase();
  try {
    await ensure(db);
    await setMeta(db, "running", "Descargando catálogo de Tecnosinergia...");
    await settings.load(true);
    const token = settings.get("TECNO_API_TOKEN");
    if (!token) { await setMeta(db, "error", "No hay variable TECNO_API_TOKEN en Netlify.", 0, 0, true); return new Response("ok"); }

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
    } finally { clearTimeout(timer); }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* no JSON */ }
    if (!parsed) { await setMeta(db, "error", "Tecnosinergia respondió HTTP " + r.status + " sin JSON válido: " + String(text).replace(/\s+/g, " ").slice(0, 160), 0, 0, true); return new Response("ok"); }
    if (parsed.status === false) { await setMeta(db, "error", "Tecnosinergia: " + (parsed.message || parsed.messsage || "error") + " (código " + parsed.code + ")", 0, 0, true); return new Response("ok"); }

    const items = tecno.slimList(parsed);
    if (!items || !items.length) { await setMeta(db, "error", "Tecnosinergia respondió, pero sin lista de productos.", 0, 0, true); return new Response("ok"); }

    await db.sql`DELETE FROM gaso_tecno_chunks`;
    let n = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      await db.sql`INSERT INTO gaso_tecno_chunks (idx, data) VALUES (${n}, ${JSON.stringify(items.slice(i, i + CHUNK))})`;
      n++;
    }
    await setMeta(db, "ok", "Catálogo guardado.", items.length, n, true);
  } catch (e) {
    try { await setMeta(db, "error", (e.name === "AbortError" ? "Tecnosinergia tardó más de 12 minutos en responder." : String(e.message || e)).slice(0, 300), 0, 0, true); } catch (e2) { /* sin DB */ }
  }
  return new Response("ok");
};
