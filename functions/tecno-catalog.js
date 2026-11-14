import { requireAuth, resp } from "../lib/session.js";

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
  if (request.method !== "GET") return json(405, { status: false, message: "Método no permitido" });

  const db = env.DB;
  const url = new URL(request.url);
  try {
    const chunk = url.searchParams.get("chunk");
    if (chunk != null) {
      const idx = parseInt(chunk, 10);
      if (!(idx >= 0)) return json(400, { status: false, message: "Bloque inválido" });
      const rows = await db.prepare("SELECT data FROM gaso_tecno_chunks WHERE idx = ?1").bind(idx).all();
      if (!rows.results || !rows.results.length) return json(404, { status: false, message: "Bloque no encontrado" });
      return new Response('{"status":true,"items":' + rows.results[0].data + "}", { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const m = await db.prepare("SELECT status, total, chunks, message, started_at, finished_at FROM gaso_tecno_meta WHERE id = 1").all();
    if (!m.results || !m.results.length) return json(200, { status: true, state: "none", total: 0, chunks: 0, message: "" });
    const x = m.results[0];
    return json(200, { status: true, state: x.status, total: x.total, chunks: x.chunks, message: x.message, startedAt: x.started_at, finishedAt: x.finished_at });
  } catch (e) {
    const msg = String(e.message || e);
    if (/no such table|does not exist/i.test(msg)) return json(200, { status: true, state: "none", total: 0, chunks: 0, message: "" });
    return json(500, { status: false, message: "Base de datos: " + msg.slice(0, 200) });
  }
}