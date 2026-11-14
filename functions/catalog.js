import { requireAuth, resp } from "../lib/session.js";

const NAMES = ["syscom", "ct"];

async function handle(context) {
  const request = context.request;
  const env = context.env;

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "", env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  if (!NAMES.includes(name)) return resp(400, { status: false, message: "Catálogo inválido" });
  const part = Math.max(0, parseInt(url.searchParams.get("part"), 10) || 0);

  try {
    const metaRes = await env.DB.prepare(
      `SELECT COUNT(*) AS parts, COALESCE(SUM(n),0) AS total FROM gaso_catalog_parts WHERE name = ?1`
    ).bind(name).first();
    if (!metaRes || !metaRes.parts) {
      return resp(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });
    }

    const rows = await env.DB.prepare(
      `SELECT data FROM gaso_catalog_parts WHERE name = ?1 AND part = ?2`
    ).bind(name, part).all();
    if (!rows.results || !rows.results.length) {
      return resp(404, { status: false, message: "Parte no encontrada" });
    }

    return new Response(
      `{"part":${part},"parts":${metaRes.parts},"total":${metaRes.total},"rows":${rows.results[0].data}}`,
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store"
        }
      }
    );
  } catch (e) {
    const msg = String(e.message || e);
    if (/no such table|does not exist|relation/i.test(msg)) {
      return resp(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });
    }
    return resp(500, { status: false, message: "Base de datos: " + msg.slice(0, 200) });
  }
}

export async function onRequestGet(context) {
  return handle(context);
}

export async function onRequestPost(context) {
  return handle(context);
}
