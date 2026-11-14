import { requireAuth, resp } from "../lib/session.js";

const NAMES = ["syscom", "ct"];
const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "");
  if (auth.error) return auth.error;
  if (auth.session.r !== "SUPERADMIN") return json(403, { status: false, message: "Solo el superusuario puede importar catálogos." });
  if (request.method !== "POST") return json(405, { status: false, message: "Método no permitido" });

  let b;
  try { b = await request.json(); } catch (e) { return json(400, { status: false, message: "JSON inválido" }); }
  const part = parseInt(b.part, 10);
  if (!NAMES.includes(b.name) || !(part >= 0) || !Array.isArray(b.rows) || !b.rows.length) return json(400, { status: false, message: "Datos inválidos" });

  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gaso_catalog_parts (name TEXT NOT NULL, part INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, part))`).run();
    if (part === 0) await env.DB.prepare(`DELETE FROM gaso_catalog_parts WHERE name = ?1`).bind(b.name).run();
    const data = JSON.stringify(b.rows);
    await env.DB.prepare(`INSERT INTO gaso_catalog_parts (name, part, n, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(name, part) DO UPDATE SET n = excluded.n, data = excluded.data`).bind(b.name, part, b.rows.length, data).run();
    return json(200, { status: true, part, saved: b.rows.length });
  } catch (e) {
    return json(500, { status: false, message: "Base de datos: " + String(e.message).slice(0, 200) });
  }
}