import { requireAuth, resp } from "../lib/session.js";

const NAMES = ["syscom", "ct"];

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "");
  if (auth.error) return auth.error;
  if (request.method !== "GET") return await resp(405, { status: false, message: "Método no permitido" });

  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  if (!NAMES.includes(name)) return await resp(400, { status: false, message: "Catálogo inválido" });
  const part = Math.max(0, parseInt(url.searchParams.get("part"), 10) || 0);

  try {
    const metaRes = await env.DB.prepare(`SELECT COUNT(*) AS parts, COALESCE(SUM(n),0) AS total FROM gaso_catalog_parts WHERE name = ?1`).bind(name).first();
    if (!metaRes || !metaRes.parts) return await resp(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });

    const rows = await env.DB.prepare(`SELECT data FROM gaso_catalog_parts WHERE name = ?1 AND part = ?2`).bind(name, part).all();
    if (!rows.results || !rows.results.length) return await resp(404, { status: false, message: "Parte no encontrada" });

    return new Response(`{"part":${part},"parts":${metaRes.parts},"total":${metaRes.total},"rows":${rows.results[0].data}}`, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/no such table|does not exist|relation/i.test(msg)) return await resp(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });
    return await resp(500, { status: false, message: "Base de datos: " + msg.slice(0, 200) });
  }
}