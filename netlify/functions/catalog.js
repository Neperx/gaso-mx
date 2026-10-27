// Catálogos Syscom / CT guardados en la base de datos (no en el repositorio). Solo con sesión.
//   GET ?name=syscom|ct&part=N -> { part, parts, total, rows }
import { getDatabase } from "@netlify/database";
import session from "../lib/session.js";

const NAMES = ["syscom", "ct"];
const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }
});

export default async (req) => {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const auth = session.requireAuth({ headers, httpMethod: req.method });
  if (auth.error) return new Response(auth.error.body, { status: auth.error.statusCode, headers: auth.error.headers });
  if (req.method !== "GET") return json(405, { status: false, message: "Método no permitido" });

  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!NAMES.includes(name)) return json(400, { status: false, message: "Catálogo inválido" });
  const part = Math.max(0, parseInt(url.searchParams.get("part"), 10) || 0);
  try {
    const db = getDatabase();
    const meta = await db.sql`SELECT COUNT(*)::int AS parts, COALESCE(SUM(n),0)::int AS total FROM gaso_catalog_parts WHERE name = ${name}`;
    if (!meta[0].parts) return json(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });
    const rows = await db.sql`SELECT data FROM gaso_catalog_parts WHERE name = ${name} AND part = ${part}`;
    if (!rows.length) return json(404, { status: false, message: "Parte no encontrada" });
    return new Response(`{"part":${part},"parts":${meta[0].parts},"total":${meta[0].total},"rows":${rows[0].data}}`, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }
    });
  } catch (e) {
    if (/does not exist|relation/i.test(String(e.message))) return json(404, { status: false, message: "Catálogo no cargado: impórtalo en ⚙️ Configuración." });
    return json(500, { status: false, message: "Base de datos: " + String(e.message).slice(0, 200) });
  }
};
