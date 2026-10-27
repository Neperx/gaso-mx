// Lee la copia del catálogo de Tecnosinergia guardada por tecno-sync-background.
//   GET            -> estado { status: none|running|ok|error, total, chunks, message }
//   GET ?chunk=N   -> productos del bloque N (1000 por bloque)
import { getDatabase } from "@netlify/database";
import session from "../lib/session.js";

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export default async (req) => {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const auth = session.requireAuth({ headers, httpMethod: req.method });
  if (auth.error) return new Response(auth.error.body, { status: auth.error.statusCode });
  if (req.method !== "GET") return json(405, { status: false, message: "Método no permitido" });

  const db = getDatabase();
  const url = new URL(req.url);
  try {
    const chunk = url.searchParams.get("chunk");
    if (chunk != null) {
      const idx = parseInt(chunk, 10);
      if (!(idx >= 0)) return json(400, { status: false, message: "Bloque inválido" });
      const rows = await db.sql`SELECT data FROM gaso_tecno_chunks WHERE idx = ${idx}`;
      if (!rows.length) return json(404, { status: false, message: "Bloque no encontrado" });
      return new Response('{"status":true,"items":' + rows[0].data + "}", { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const m = await db.sql`SELECT status, total, chunks, message, started_at, finished_at FROM gaso_tecno_meta WHERE id = 1`;
    if (!m.length) return json(200, { status: true, state: "none", total: 0, chunks: 0, message: "" });
    const x = m[0];
    return json(200, { status: true, state: x.status, total: x.total, chunks: x.chunks, message: x.message, startedAt: x.started_at, finishedAt: x.finished_at });
  } catch (e) {
    if (/does not exist|relation/i.test(String(e.message))) return json(200, { status: true, state: "none", total: 0, chunks: 0, message: "" });
    return json(500, { status: false, message: "Base de datos: " + String(e.message).slice(0, 200) });
  }
};
