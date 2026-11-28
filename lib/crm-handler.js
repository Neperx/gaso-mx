import { requireAuth, resp } from "./session.js";

const FOLIO_RE = /^(?:COT|NV)(?:-([A-Z0-9]+))?-(\d{4})-(\d+)$/;

function parseFolio(f) {
  const m = String(f || "").match(FOLIO_RE);
  if (!m) return null;
  const series = m[1] ? m[1].toUpperCase() : "";
  const year = Number(m[2]);
  const seq = parseInt(m[3], 10);
  const key = series ? `${series}_${year}` : String(year);
  return { series, year, seq, key };
}

function folioSeqOf(list) {
  const perKey = {};
  (list || []).forEach((q) => {
    [q && q.number, q && q.refCotFolio].forEach((f) => {
      const parsed = parseFolio(f);
      if (parsed) {
        const { key, seq } = parsed;
        if (!perKey[key] || seq > perKey[key]) perKey[key] = seq;
      }
    });
  });
  return perKey;
}

function nextFolio(year, seq, series = "") {
  const prefix = series ? `COT-${series}-` : "COT-";
  return prefix + year + "-" + String(seq + 1).padStart(3, "0");
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
  const out = {};
  try {
    const { results } = await db.prepare("SELECT year, seq FROM gaso_folio_seq").all();
    (results || []).forEach((r) => { out[String(r.year)] = r.seq; });
  } catch (e) {}
  try {
    const { results: sResults } = await db.prepare("SELECT series_key, seq FROM gaso_series_seq").all();
    (sResults || []).forEach((r) => {
      out[String(r.series_key)] = Math.max(out[String(r.series_key)] || 0, r.seq);
    });
  } catch (e) {}
  return out;
}

async function bumpFolioSeq(db, perKey) {
  for (const k of Object.keys(perKey)) {
    const key = String(k);
    const seq = perKey[k];
    if (/^\d+$/.test(key)) {
      try {
        await db
          .prepare(
            "INSERT INTO gaso_folio_seq (year, seq) VALUES (?1, ?2) ON CONFLICT(year) DO UPDATE SET seq = MAX(gaso_folio_seq.seq, excluded.seq)"
          )
          .bind(Number(key), seq)
          .run();
      } catch (e) {}
    }
    try {
      await db
        .prepare(
          "INSERT INTO gaso_series_seq (series_key, seq) VALUES (?1, ?2) ON CONFLICT(series_key) DO UPDATE SET seq = MAX(gaso_series_seq.seq, excluded.seq)"
        )
        .bind(key, seq)
        .run();
    } catch (e) {}
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
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_series_seq (
      series_key TEXT PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_tombstones (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gaso_projects (
      id TEXT PRIMARY KEY,
      folio_num INTEGER NOT NULL DEFAULT 0,
      client_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Cotizado',
      total REAL NOT NULL DEFAULT 0,
      paid REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_gaso_projects_folio ON gaso_projects (folio_num)`)
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

async function upsertProjects(db, projects) {
  let maxSeq = 0;
  for (const p of (projects || []).slice(0, 2000)) {
    if (!p || !p.id) continue;
    const id = String(p.id);
    const u = Number(p._u) || 0;
    if (!(await passTombstone(db, "project", id, u))) continue;
    const folioNum = parseInt(p.folioNum, 10) || 0;
    if (folioNum > maxSeq) maxSeq = folioNum;
    const total = parseFloat(p.totalAmount) || 0;
    const paid = parseFloat(p.paidAmount) || 0;
    const balance = parseFloat(p.balanceAmount) || 0;
    const data = JSON.stringify(Object.assign({}, p, { _u: u }));
    await db
      .prepare(
        `INSERT INTO gaso_projects (id, folio_num, client_name, status, total, paid, balance, data, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           folio_num = excluded.folio_num,
           client_name = excluded.client_name,
           status = excluded.status,
           total = excluded.total,
           paid = excluded.paid,
           balance = excluded.balance,
           data = excluded.data,
           updated_at = CURRENT_TIMESTAMP
         WHERE COALESCE(CAST(json_extract(gaso_projects.data, '$._u') AS INTEGER), 0) < ?9`
      )
      .bind(
        id,
        folioNum,
        String(p.clientName || ""),
        String(p.status || "Cotizado"),
        total,
        paid,
        balance,
        data,
        u
      )
      .run();
  }
  if (maxSeq > 0) {
    await bumpFolioSeq(db, { PROJECT_NUM: maxSeq });
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
    if (kind === "project") await db.prepare("DELETE FROM gaso_projects WHERE id = ?1").bind(x.key).run();
  }
}

async function loadSnapshot(db) {
  const [cRes, qRes, pRes, seq] = await Promise.all([
    db.prepare("SELECT data FROM gaso_clients ORDER BY updated_at DESC").all(),
    db.prepare("SELECT data FROM gaso_quotes ORDER BY updated_at DESC").all(),
    db.prepare("SELECT data FROM gaso_projects ORDER BY folio_num DESC, updated_at DESC").all(),
    readFolioSeq(db)
  ]);
  return {
    clients: (cRes.results || []).map((r) => parseRowData(r.data)).filter(Boolean),
    quotes: (qRes.results || []).map((r) => parseRowData(r.data)).filter(Boolean),
    projects: (pRes.results || []).map((r) => parseRowData(r.data)).filter(Boolean),
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
        const series = (url.searchParams.get("series") || "").toUpperCase();
        const key = series ? `${series}_${year}` : String(year);
        const seq = await readFolioSeq(db);
        const { results: rows } = await db.prepare("SELECT number FROM gaso_quotes").all();
        const fromRows = folioSeqOf((rows || []).map((r) => ({ number: r.number })));
        const cur = Math.max(seq[key] || 0, fromRows[key] || 0);
        return resp(200, { status: true, year, series, seq: cur, folio: nextFolio(year, cur, series) });
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
      const parsed = parseFolio(body.quote.number) || { year: new Date().getFullYear(), series: "" };
      const key = parsed.series ? `${parsed.series}_${parsed.year}` : String(parsed.year);
      const seq = await readFolioSeq(db);
      return resp(200, { status: true, folio: nextFolio(parsed.year, seq[key] || 0, parsed.series) });
    }

    if (body.op === "save-clients" && Array.isArray(body.clients)) {
      await upsertClients(db, body.clients);
      return resp(200, { status: true, count: body.clients.length });
    }

    if (body.op === "delete-quote" && body.number) {
      await applyDeletes(db, "quote", [{ key: body.number, _d: Date.now() }]);
      return resp(200, { status: true });
    }

    if (body.op === "save-project" && body.project) {
      await upsertProjects(db, [body.project]);
      const seq = await readFolioSeq(db);
      return resp(200, { status: true, nextProjectFolio: (seq.PROJECT_NUM || 0) + 1 });
    }

    if (body.op === "delete-project" && body.id) {
      await applyDeletes(db, "project", [{ key: body.id, _d: Date.now() }]);
      return resp(200, { status: true });
    }

    if (body.op === "sync") {
      await applyDeletes(db, "client", body.delClients);
      await applyDeletes(db, "quote", body.delQuotes);
      await applyDeletes(db, "project", body.delProjects);
      await upsertClients(db, body.clients || []);
      await upsertQuotes(db, body.quotes || []);
      await upsertProjects(db, body.projects || []);
      await bumpFolioSeq(db, folioSeqOf(body.quotes || []));
      const snap = await loadSnapshot(db);
      return resp(200, { status: true, ...snap });
    }

    return resp(400, { status: false, message: "Operación inválida" });
  } catch (e) {
    return resp(500, { status: false, message: "CRM: " + (e && e.message ? e.message : String(e)) });
  }
}
