// Importa un catálogo (Syscom / CT) a la base de datos, por partes. Solo SUPERADMIN.
//   POST { name, part, rows:[...] }   (part 0 borra el catálogo anterior)
import { getDatabase } from "@netlify/database";
import session from "../lib/session.js";

const NAMES = ["syscom", "ct"];
const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export default async (req) => {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const auth = session.requireAuth({ headers, httpMethod: req.method });
  if (auth.error) return new Response(auth.error.body, { status: auth.error.statusCode, headers: auth.error.headers });
  if (auth.session.r !== "SUPERADMIN") return json(403, { status: false, message: "Solo el superusuario puede importar catálogos." });
  if (req.method !== "POST") return json(405, { status: false, message: "Método no permitido" });

  let b;
  try { b = await req.json(); } catch (e) { return json(400, { status: false, message: "JSON inválido" }); }
  const part = parseInt(b.part, 10);
  if (!NAMES.includes(b.name) || !(part >= 0) || !Array.isArray(b.rows) || !b.rows.length) return json(400, { status: false, message: "Datos inválidos" });

  try {
    const db = getDatabase();
    await db.sql`CREATE TABLE IF NOT EXISTS gaso_catalog_parts (name TEXT NOT NULL, part INT NOT NULL, n INT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, part))`;
    if (part === 0) await db.sql`DELETE FROM gaso_catalog_parts WHERE name = ${b.name}`;
    const data = JSON.stringify(b.rows);
    await db.sql`INSERT INTO gaso_catalog_parts (name, part, n, data) VALUES (${b.name}, ${part}, ${b.rows.length}, ${data})
      ON CONFLICT (name, part) DO UPDATE SET n = EXCLUDED.n, data = EXCLUDED.data`;
    return json(200, { status: true, part, saved: b.rows.length });
  } catch (e) {
    return json(500, { status: false, message: "Base de datos: " + String(e.message).slice(0, 200) });
  }
};
