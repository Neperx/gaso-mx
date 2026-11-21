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
  
  const allParam = url.searchParams.get("all");
  const partParam = url.searchParams.get("part");
  const isAll = allParam === "1" || allParam === "true" || partParam === null;

  try {
    const metaRes = await env.DB.prepare(
      `SELECT COUNT(*) AS parts, COALESCE(SUM(n),0) AS total FROM gaso_catalog_parts WHERE name = ?1`
    ).bind(name).first();
    if (!metaRes || !metaRes.parts) {
      return resp(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });
    }

    // Modo ultra-rápido: consultar y ensamblar todo el catálogo en 1 sola respuesta comprimida (brotli/gzip por Cloudflare)
    if (isAll) {
      const allParts = await env.DB.prepare(
        `SELECT data FROM gaso_catalog_parts WHERE name = ?1 ORDER BY part ASC`
      ).bind(name).all();
      
      if (!allParts.results || !allParts.results.length) {
        return resp(404, { status: false, message: "Sin datos en el catálogo" });
      }

      // Concatenar eficientemente los JSON arrays: "[...],[...]" -> "[...,...]"
      const slices = [];
      for (const r of allParts.results) {
        if (typeof r.data === "string" && r.data.length > 2) {
          // Remover los corchetes "[" y "]" exteriores
          const trimmed = r.data.trim();
          if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            slices.push(trimmed.slice(1, -1));
          }
        }
      }
      const combinedJson = "[" + slices.filter(Boolean).join(",") + "]";

      return new Response(
        `{"parts":${metaRes.parts},"total":${metaRes.total},"rows":${combinedJson}}`,
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, max-age=3600"
          }
        }
      );
    }

    const part = Math.max(0, parseInt(partParam, 10) || 0);
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
