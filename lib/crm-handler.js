import { requireAuth, resp } from "./session.js";

const FOLIO_RE = /^(?:COT|NV)-(\d{4})-(\d+)$/;

function folioSeqOf(list) {
  const perYear = {};
  (list || []).forEach((q) => {
    [q && q.number, q && q.refCotFolio].forEach((f) => {
      const m = String(f || "").match(FOLIO_RE);
      if (m) {
        const y = Number(m[1]);
        const n = parseInt(m[2], 10);
        if (!perYear[y] || n > perYear[y]) perYear[y] = n;
      }
    });
  });
  return perYear;
}

function nextFolio(year, seq) {
  return "COT-" + year + "-" + String(seq + 1).padStart(3, "0");
}

function parseRowData(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function readFolioSeq(db) {
  const { results } = await db.prepare("SELECT year, seq FROM gaso_folio_seq").all();
  const out = {};
  (results || []).forEach((r) => { out[r.year] = r.seq; });
  return out;
}

async function bumpFolioSeq(db, perYear) {
  for (const y of Object.keys(perYear)) {
    const year = Number(y);
    const seq = perYear[y];
    await db
      .prepare(
        "INSERT INTO gaso_folio_seq (year, seq) VALUES (?1, ?2) ON CONFLICT(year) DO UPDATE SET seq = MAX(gaso_folio_seq.seq, excluded.seq)"
      )
      .bind(year, seq)
      .run();
  }
}

async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_quotes (
      number TEXT PRIMARY KEY,
      client_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      quote_date TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_gaso_quotes_client ON gaso_quotes (client_name)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_folio_seq (
      year INTEGER PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_tombstones (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    )`)
  ]);
}

async function passTombstone(db, kind, key, u) {
  const { results } = await db
    .prepare("SELECT deleted_at FROM gaso_tombstones WHERE kind = ?1 AND key = ?2")
    .bind(kind, key)
    .all();
  if (results && results.length) {
    if (Number(results[0].deleted_at) >= u) return false;
    await db.prepare("DELETE FROM gaso_tombstones WHERE kind = ?1 AND key = ?2").bind(kind, key).run();
  }
  return true;
}

async function upsertClients(db, clients) {
  for (const c of (clients || []).slice(0, 2000)) {
    if (!c || !c.id || !c.name) continue;
    const id = String(c.id);
    const u = Number(c._u) || 0;
    if (!(await passTombstone(db, "client", id, u))) continue;
    const data = JSON.stringify(Object.assign({}, c, { _u: u }));
    await db
      .prepare(
        `INSERT INTO gaso_clients (id, name, data, updated_at)
         VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           data = excluded.data,
           updated_at = CURRENT_TIMESTAMP
         WHERE COALESCE(CAST(json_extract(gaso_clients.data, '$._u') AS INTEGER), 0) < ?4`
      )
      .bind(id, c.name, data, u)
      .run();
  }
}

async function upsertQuotes(db, quotes) {
  for (const q of (quotes || []).slice(0, 2000)) {
    if (!q || !q.number) continue;
    const number = String(q.number);
    const u = Number(q._u) || 0;
    if (!(await passTombstone(db, "quote", number, u))) continue;
    const total = parseFloat(q.totalAmount) || 0;
    const data = JSON.stringify(Object.assign({}, q, { _u: u }));
    await db
      .prepare(
        `INSERT INTO gaso_quotes (number, client_name, status, quote_date, total, data, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
         ON CONFLICT(number) DO UPDATE SET
           client_name = excluded.client_name,
           status = excluded.status,
           quote_date = excluded.quote_date,
           total = excluded.total,
           data = excluded.data,
           updated_at = CURRENT_TIMESTAMP
         WHERE COALESCE(CAST(json_extract(gaso_quotes.data, '$._u') AS INTEGER), 0) < ?7`
      )
      .bind(
        number,
        String((q.client && q.client.name) || ""),
        String(q.status || "draft"),
        String(q.date || ""),
        total,
        data,
        u
      )
      .run();
  }
}

async function applyDeletes(db, kind, items) {
  for (const x of items || []) {
    if (!x || !x.key) continue;
    await db
      .prepare("INSERT OR IGNORE INTO gaso_tombstones (kind, key, deleted_at) VALUES (?1, ?2, ?3)")
      .bind(kind, x.key, x._d || Date.now())
      .run();
    if (kind === "client") await db.prepare("DELETE FROM gaso_clients WHERE id = ?1").bind(x.key).run();
    if (kind === "quote") await db.prepare("DELETE FROM gaso_quotes WHERE number = ?1").bind(x.key).run();
  }
}

async function loadSnapshot(db) {
  const [cRes, qRes, seq] = await Promise.all([
    db.prepare("SELECT data FROM gaso_clients ORDER BY updated_at DESC").all(),
    db.prepare("SELECT data FROM gaso_quotes ORDER BY updated_at DESC").all(),
    readFolioSeq(db)
  ]);
  return {
    clients: (cRes.results || []).map((r) => parseRowData(r.data)).filter(Boolean),
    quotes: (qRes.results || []).map((r) => parseRowData(r.data)).filter(Boolean),
    folioSeq: seq
  };
}

export default async function crmHandler(request, env) {
  try {
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const auth = await requireAuth({ headers }, env.SESSION_SECRET || "", env);
    if (auth.error) return auth.error;

    const db = env.DB;
    if (!db) return resp(500, { status: false, message: "Base D1 no vinculada (binding DB)." });
    await ensureTables(db);

    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.get("op") === "next-folio") {
        const year = parseInt(url.searchParams.get("year") || String(new Date().getFullYear()), 10);
        const seq = await readFolioSeq(db);
        const { results: rows } = await db.prepare("SELECT number FROM gaso_quotes").all();
        const fromRows = folioSeqOf((rows || []).map((r) => ({ number: r.number })));
        const cur = Math.max(seq[year] || 0, fromRows[year] || 0);
        return resp(200, { status: true, year, seq: cur, folio: nextFolio(year, cur) });
      }
      const snap = await loadSnapshot(db);
      return resp(200, { status: true, ...snap }, { "Cache-Control": "private, no-store" });
    }

    if (request.method !== "POST") return resp(405, { status: false, message: "Método no permitido" });

    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return resp(400, { status: false, message: "JSON inválido" });
    }

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
      await applyDeletes(db, "client", body.delClients);
      await applyDeletes(db, "quote", body.delQuotes);
      await upsertClients(db, body.clients || []);
      await upsertQuotes(db, body.quotes || []);
      await bumpFolioSeq(db, folioSeqOf(body.quotes || []));
      const snap = await loadSnapshot(db);
      return resp(200, { status: true, ...snap });
    }

    return resp(400, { status: false, message: "Operación inválida" });
  } catch (e) {
    return resp(500, { status: false, message: "CRM: " + (e && e.message ? e.message : String(e)) });
  }
}
