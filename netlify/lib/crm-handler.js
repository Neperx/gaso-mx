// CRM compartido: clientes, notas y contador de folios en Netlify Database.
// Solo responde con sesión válida (cookie gaso_session). Sin sesión → 401.
const { requireAuth, resp } = require("./session");
const { getDatabase } = require("@netlify/database");

const FOLIO_RE = /^(?:COT|NV)-(\d{4})-(\d+)$/;

function folioSeqOf(list) {
  const perYear = {};
  (list || []).forEach((q) => {
    [q && q.number, q && q.refCotFolio].forEach((f) => {
      const m = String(f || "").match(FOLIO_RE);
      if (m) {
        const y = Number(m[1]), n = parseInt(m[2], 10);
        if (!perYear[y] || n > perYear[y]) perYear[y] = n;
      }
    });
  });
  return perYear;
}

function nextFolio(year, seq) {
  return "COT-" + year + "-" + String(seq + 1).padStart(3, "0");
}

async function readFolioSeq(db) {
  const rows = await db.sql`SELECT year, seq FROM gaso_folio_seq`;
  const out = {};
  rows.forEach((r) => { out[r.year] = r.seq; });
  return out;
}

async function bumpFolioSeq(db, perYear) {
  for (const y of Object.keys(perYear)) {
    const year = Number(y), seq = perYear[y];
    await db.sql`
      INSERT INTO gaso_folio_seq (year, seq) VALUES (${year}, ${seq})
      ON CONFLICT (year) DO UPDATE SET seq = GREATEST(gaso_folio_seq.seq, EXCLUDED.seq)`;
  }
}

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  try {
    await db.sql`CREATE TABLE IF NOT EXISTS gaso_tombstones (
      kind TEXT NOT NULL, key TEXT NOT NULL, deleted_at BIGINT NOT NULL, PRIMARY KEY (kind, key))`;
  } catch (e) { /* la migración 0002 ya la crea */ }
  tablesReady = true;
}

// Devuelve true si el elemento puede escribirse (no fue borrado después de su última edición).
async function passTombstone(db, kind, key, u) {
  const t = await db.sql`SELECT deleted_at FROM gaso_tombstones WHERE kind = ${kind} AND key = ${key}`;
  if (t.length) {
    if (Number(t[0].deleted_at) >= u) return false;
    await db.sql`DELETE FROM gaso_tombstones WHERE kind = ${kind} AND key = ${key}`;
  }
  return true;
}

// Gana la versión con _u (marca de tiempo de edición) más reciente.
async function upsertClients(db, clients) {
  for (const c of (clients || []).slice(0, 2000)) {
    if (!c || !c.id || !c.name) continue;
    const id = String(c.id), u = Number(c._u) || 0;
    if (!(await passTombstone(db, "client", id, u))) continue;
    const data = JSON.stringify(Object.assign({}, c, { _u: u }));
    await db.sql`
      INSERT INTO gaso_clients (id, name, data, updated_at)
      VALUES (${id}, ${String(c.name)}, ${data}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = NOW()
      WHERE COALESCE((gaso_clients.data->>'_u')::bigint, 0) < ${u}`;
  }
}

async function upsertQuotes(db, quotes) {
  for (const q of (quotes || []).slice(0, 2000)) {
    if (!q || !q.number) continue;
    const number = String(q.number), u = Number(q._u) || 0;
    if (!(await passTombstone(db, "quote", number, u))) continue;
    const total = parseFloat(q.totalAmount) || 0;
    const data = JSON.stringify(Object.assign({}, q, { _u: u }));
    await db.sql`
      INSERT INTO gaso_quotes (number, client_name, status, quote_date, total, data, updated_at)
      VALUES (${number}, ${String((q.client && q.client.name) || "")}, ${String(q.status || "draft")}, ${String(q.date || "")}, ${total}, ${data}::jsonb, NOW())
      ON CONFLICT (number) DO UPDATE SET client_name = EXCLUDED.client_name, status = EXCLUDED.status, quote_date = EXCLUDED.quote_date, total = EXCLUDED.total, data = EXCLUDED.data, updated_at = NOW()
      WHERE COALESCE((gaso_quotes.data->>'_u')::bigint, 0) < ${u}`;
  }
}

async function applyDeletes(db, kind, list) {
  for (const x of (list || []).slice(0, 2000)) {
    if (!x || !x.key) continue;
    const key = String(x.key), d = Number(x._d) || Date.now();
    if (kind === "client") {
      const cur = await db.sql`SELECT data->>'_u' AS u FROM gaso_clients WHERE id = ${key}`;
      if (cur.length && (Number(cur[0].u) || 0) > d) continue;
      await db.sql`DELETE FROM gaso_clients WHERE id = ${key}`;
    } else {
      const cur = await db.sql`SELECT data->>'_u' AS u FROM gaso_quotes WHERE number = ${key}`;
      if (cur.length && (Number(cur[0].u) || 0) > d) continue;
      await db.sql`DELETE FROM gaso_quotes WHERE number = ${key}`;
    }
    await db.sql`
      INSERT INTO gaso_tombstones (kind, key, deleted_at) VALUES (${kind}, ${key}, ${d})
      ON CONFLICT (kind, key) DO UPDATE SET deleted_at = GREATEST(gaso_tombstones.deleted_at, EXCLUDED.deleted_at)`;
  }
}

exports.handler = async (event) => {
  const auth = requireAuth(event);
  if (auth.error) return auth.error;

  let db;
  try {
    db = getDatabase();
    await ensureTables(db);
  } catch (e) {
    return resp(500, { status: false, message: "Base de datos no disponible: " + e.message });
  }

  try {
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      if (q.op === "next-folio") {
        const year = parseInt(q.year, 10) || new Date().getFullYear();
        const seq = await readFolioSeq(db);
        // El siguiente folio considera el contador y el folio máximo guardado
        const rows = await db.sql`SELECT number FROM gaso_quotes`;
        const fromRows = folioSeqOf(rows.map((r) => ({ number: r.number })));
        const cur = Math.max(seq[year] || 0, fromRows[year] || 0);
        return resp(200, { status: true, year, seq: cur, folio: nextFolio(year, cur) });
      }
      // op=pull (por defecto): todo lo compartido
      const [cRows, qRows, seq] = await Promise.all([
        db.sql`SELECT data FROM gaso_clients ORDER BY updated_at DESC`,
        db.sql`SELECT data FROM gaso_quotes ORDER BY updated_at DESC`,
        readFolioSeq(db),
      ]);
      return resp(200, {
        status: true,
        clients: cRows.map((r) => r.data),
        quotes: qRows.map((r) => r.data),
        folioSeq: seq,
      }, { "Cache-Control": "private, no-store" });
    }

    if (event.httpMethod !== "POST") return resp(405, { status: false, message: "Método no permitido" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return resp(400, { status: false, message: "JSON inválido" }); }

    if (body.op === "save-quote" && body.quote) {
      await upsertQuotes(db, [body.quote]);
      await bumpFolioSeq(db, folioSeqOf([body.quote]));
      const year = new Date().getFullYear();
      const seq = await readFolioSeq(db);
      return resp(200, { status: true, folio: nextFolio(year, seq[year] || 0) });
    }

    if (body.op === "save-clients" && Array.isArray(body.clients)) {
      await upsertClients(db, body.clients);
      return resp(200, { status: true, count: body.clients.length });
    }

    if (body.op === "delete-quote" && body.number) {
      await applyDeletes(db, "quote", [{ key: body.number, _d: Date.now() }]);
      return resp(200, { status: true });
    }

    if (body.op === "sync") {
      // Sincronización incremental: aplica cambios y borrados del navegador (gana la edición
      // más reciente) y devuelve el estado global, que el navegador adopta como espejo.
      const clients = Array.isArray(body.clients) ? body.clients : [];
      const quotes = Array.isArray(body.quotes) ? body.quotes : [];
      await applyDeletes(db, "client", body.delClients);
      await applyDeletes(db, "quote", body.delQuotes);
      await upsertClients(db, clients);
      await upsertQuotes(db, quotes);
      await bumpFolioSeq(db, folioSeqOf(quotes));
      const [cRows, qRows, seq] = await Promise.all([
        db.sql`SELECT data FROM gaso_clients ORDER BY updated_at DESC`,
        db.sql`SELECT data FROM gaso_quotes ORDER BY updated_at DESC`,
        readFolioSeq(db),
      ]);
      return resp(200, {
        status: true,
        clients: cRows.map((r) => r.data),
        quotes: qRows.map((r) => r.data),
        folioSeq: seq,
      });
    }

    return resp(400, { status: false, message: "Operación inválida" });
  } catch (e) {
    return resp(500, { status: false, message: e.message });
  }
};
