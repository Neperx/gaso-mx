import { requireAuth, resp } from "./session.js";

/**
 * Endpoint para gestión de la Caja Fuerte (Vault).
 * Almacena los registros con los campos sensibles ya cifrados desde el cliente
 * mediante Web Crypto API (AES-GCM-256) con el PIN / Clave Maestra / TOTP del usuario.
 * También gestiona el secreto TOTP de forma persistente en D1 (gaso_settings).
 */
export default async function vaultHandler(request, env) {
  const auth = await requireAuth(request, env.SESSION_SECRET || "");
  if (!auth.ok) {
    return resp(auth.status, { ok: false, message: auth.message });
  }

  // Restricción: solo SUPERADMIN
  if (auth.session.r !== "SUPERADMIN") {
    return resp(403, { ok: false, message: "Acceso exclusivo para Superusuario." });
  }

  const db = env.DB;
  if (!db) {
    return resp(500, { ok: false, message: "Base de datos D1 no vinculada (env.DB falta)." });
  }

  // Asegurar tabla gaso_vault y gaso_settings
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

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS gaso_settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run().catch(() => {});

  const method = request.method.toUpperCase();

  // GET: Listar todos los registros y estado del TOTP
  if (method === "GET") {
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action");

      // Consultar secreto TOTP configurado en D1
      if (action === "get_totp") {
        const row = await db.prepare("SELECT value FROM gaso_settings WHERE name = 'VAULT_TOTP_SECRET'").first();
        return resp(200, { ok: true, hasTotp: !!(row && row.value), secret: row ? row.value : null });
      }

      const { results } = await db.prepare("SELECT * FROM gaso_vault ORDER BY updated_at DESC").all();
      return resp(200, { ok: true, items: results || [] });
    } catch (e) {
      return resp(500, { ok: false, message: "Error al leer bóveda: " + e.message });
    }
  }

  // POST: Crear, actualizar, eliminar registros o guardar secreto TOTP
  if (method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return resp(400, { ok: false, message: "JSON inválido." });
    }

    const action = body.action || "save";

    // Guardar secreto TOTP en D1 de forma permanente (para no perderlo al borrar cookies o cambiar de PC)
    if (action === "save_totp") {
      const secret = String(body.secret || "").trim();
      if (!secret) return resp(400, { ok: false, message: "Secreto TOTP requerido." });
      try {
        await db.prepare(`
          INSERT INTO gaso_settings (name, value, updated_at)
          VALUES ('VAULT_TOTP_SECRET', ?1, CURRENT_TIMESTAMP)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).bind(secret).run();
        return resp(200, { ok: true, message: "Google Authenticator configurado permanentemente en la base de datos." });
      } catch (e) {
        return resp(500, { ok: false, message: "Error al guardar TOTP en DB: " + e.message });
      }
    }

    // Eliminar registro
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
