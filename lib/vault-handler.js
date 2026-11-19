import { requireAuth, resp } from "./session.js";

/**
 * Endpoint para gestión de la Caja Fuerte (Vault).
 * Almacena los registros con los campos sensibles ya cifrados desde el cliente
 * mediante Web Crypto API (AES-GCM-256) con el PIN / Clave Maestra / TOTP del usuario.
 */
export default async function vaultHandler(request, env) {
  const auth = await requireAuth(request, env.SESSION_SECRET || "");
  if (!auth.ok) {
    return resp(auth.status, { ok: false, message: auth.message });
  }

  // Restricción opcional: solo SUPERADMIN
  if (auth.session.r !== "SUPERADMIN") {
    return resp(403, { ok: false, message: "Acceso exclusivo para Superusuario." });
  }

  const db = env.DB;
  if (!db) {
    return resp(500, { ok: false, message: "Base de datos D1 no vinculada (env.DB falta)." });
  }

  // Asegurar tabla y columnas extendidas (client_id, client_name, port, p2p)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS gaso_vault (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      client_id TEXT NOT NULL DEFAULT '',
      client_name TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      password_encrypted TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      port TEXT NOT NULL DEFAULT '',
      p2p TEXT NOT NULL DEFAULT '',
      notes_encrypted TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run().catch(() => {});

  const method = request.method.toUpperCase();

  // GET: Listar todos los registros
  if (method === "GET") {
    try {
      const { results } = await db.prepare("SELECT * FROM gaso_vault ORDER BY updated_at DESC").all();
      return resp(200, { ok: true, items: results || [] });
    } catch (e) {
      return resp(500, { ok: false, message: "Error al leer bóveda: " + e.message });
    }
  }

  // POST: Crear, actualizar o eliminar registros
  if (method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return resp(400, { ok: false, message: "JSON inválido." });
    }

    const action = body.action || "save";

    // Eliminar
    if (action === "delete") {
      const id = body.id;
      if (!id) return resp(400, { ok: false, message: "ID requerido para eliminar." });
      try {
        await db.prepare("DELETE FROM gaso_vault WHERE id = ?").bind(id).run();
        return resp(200, { ok: true, message: "Registro eliminado." });
      } catch (e) {
        return resp(500, { ok: false, message: "Error al eliminar: " + e.message });
      }
    }

    // Guardar (insert or update)
    if (action === "save") {
      const item = body.item;
      if (!item || !item.id || !item.title) {
        return resp(400, { ok: false, message: "Datos incompletos (id y title son obligatorios)." });
      }

      try {
        await db.prepare(`
          INSERT INTO gaso_vault (
            id, title, category, client_id, client_name, username, password_encrypted, url, port, p2p, notes_encrypted, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            category = excluded.category,
            client_id = excluded.client_id,
            client_name = excluded.client_name,
            username = excluded.username,
            password_encrypted = excluded.password_encrypted,
            url = excluded.url,
            port = excluded.port,
            p2p = excluded.p2p,
            notes_encrypted = excluded.notes_encrypted,
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          String(item.id),
          String(item.title || ""),
          String(item.category || "general"),
          String(item.client_id || ""),
          String(item.client_name || ""),
          String(item.username || ""),
          String(item.password_encrypted || ""),
          String(item.url || ""),
          String(item.port || ""),
          String(item.p2p || ""),
          String(item.notes_encrypted || "")
        ).run();

        return resp(200, { ok: true, message: "Registro guardado exitosamente." });
      } catch (e) {
        return resp(500, { ok: false, message: "Error al guardar en bóveda: " + e.message });
      }
    }

    return resp(400, { ok: false, message: "Acción no reconocida." });
  }

  return resp(405, { ok: false, message: "Método no permitido." });
}
