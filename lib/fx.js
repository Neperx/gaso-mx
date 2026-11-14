/** Tipo de cambio USD→MXN automático (sin llave). */

const FX_NAME = "USD_MXN_RATE";
const FX_AT = "USD_MXN_RATE_AT";

async function fetchUsdMxn() {
  const sources = [
    async () => {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      const n = Number(j && j.rates && j.rates.MXN);
      if (!(n > 10 && n < 50)) throw new Error("er-api inválido");
      return { rate: n, source: "open.er-api.com" };
    },
    async () => {
      const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=MXN", { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      const n = Number(j && j.rates && j.rates.MXN);
      if (!(n > 10 && n < 50)) throw new Error("frankfurter inválido");
      return { rate: n, source: "frankfurter.app" };
    },
    async () => {
      const r = await fetch("https://economia.awesomeapi.com.br/json/last/USD-MXN", { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      const n = Number(j && j.USDMXN && (j.USDMXN.bid || j.USDMXN.ask));
      if (!(n > 10 && n < 50)) throw new Error("awesomeapi inválido");
      return { rate: n, source: "awesomeapi" };
    }
  ];
  let last = null;
  for (const fn of sources) {
    try {
      const r = await fn();
      return { rate: Math.round(r.rate * 10000) / 10000, source: r.source, at: new Date().toISOString() };
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("No se pudo obtener el tipo de cambio");
}

async function saveFx(db, rate, source) {
  if (!db) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS gaso_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ).run();
  const at = new Date().toISOString();
  await db.prepare(
    "INSERT INTO gaso_settings (name, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).bind(FX_NAME, String(rate)).run();
  await db.prepare(
    "INSERT INTO gaso_settings (name, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).bind(FX_AT, JSON.stringify({ at, source: source || "" })).run();
  return { rate, at, source };
}

async function loadFx(db) {
  try {
    const row = await db.prepare("SELECT value FROM gaso_settings WHERE name = ?1").bind(FX_NAME).first();
    const meta = await db.prepare("SELECT value FROM gaso_settings WHERE name = ?1").bind(FX_AT).first();
    const rate = parseFloat(row && row.value);
    let at = null, source = "";
    try {
      const m = JSON.parse((meta && meta.value) || "{}");
      at = m.at || null;
      source = m.source || "";
    } catch (e) { /* ignore */ }
    if (rate > 10 && rate < 50) return { rate, at, source };
  } catch (e) { /* ignore */ }
  return null;
}

function isStale(atIso, maxAgeHours = 20) {
  if (!atIso) return true;
  const t = new Date(atIso).getTime();
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > maxAgeHours * 3600 * 1000;
}

async function ensureFreshFx(db, force = false) {
  const cur = await loadFx(db);
  if (!force && cur && !isStale(cur.at, 20)) return { ...cur, refreshed: false };
  const fresh = await fetchUsdMxn();
  await saveFx(db, fresh.rate, fresh.source);
  return { rate: fresh.rate, at: fresh.at, source: fresh.source, refreshed: true };
}

export { FX_NAME, FX_AT, fetchUsdMxn, saveFx, loadFx, isStale, ensureFreshFx };
export default { fetchUsdMxn, saveFx, loadFx, isStale, ensureFreshFx };
