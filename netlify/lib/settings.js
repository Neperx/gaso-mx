// Configuración editable desde la página (⚙️ Configuración). Las llaves se guardan CIFRADAS
// (AES-256-GCM con una clave derivada de SESSION_SECRET) en la base de datos de Netlify y
// nunca se devuelven al navegador. Si un valor no está en el panel, se usa la variable de Netlify.
const crypto = require("crypto");

const NAMES = ["AI_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL", "ANTHROPIC_API_KEY", "AI_MODEL", "TECNO_API_TOKEN"];
const SECRET = new Set(["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "TECNO_API_TOKEN"]);
const TTL_MS = 15000;

let cache = {};
let loadedAt = 0;
let tableReady = false;

function encKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) return null;
  return crypto.createHash("sha256").update("gaso-settings:" + s).digest();
}

function enc(text) {
  const k = encKey();
  if (!k) throw new Error("SESSION_SECRET no configurado (mínimo 32 caracteres)");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function dec(s) {
  const k = encKey();
  if (!k || !String(s).startsWith("v1:")) return "";
  const raw = Buffer.from(String(s).slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

function database() {
  const { getDatabase } = require("@netlify/database");
  return getDatabase();
}

async function ensureTable(db) {
  if (tableReady) return;
  await db.sql`CREATE TABLE IF NOT EXISTS gaso_settings (
    name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  tableReady = true;
}

async function load(force) {
  if (!force && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    const db = database();
    try { await ensureTable(db); } catch (e) { /* la migración ya la crea */ }
    const rows = await db.sql`SELECT name, value FROM gaso_settings`;
    const m = {};
    rows.forEach((r) => {
      try { m[r.name] = SECRET.has(r.name) ? dec(r.value) : r.value; } catch (e) { /* valor ilegible: se ignora */ }
    });
    cache = m;
  } catch (e) { /* sin base de datos: se usan las variables de Netlify */ }
  loadedAt = Date.now();
  return cache;
}

// Debe llamarse después de await load()
function get(name) {
  const v = cache[name];
  if (v != null && v !== "") return v;
  return process.env[name] || "";
}

function source(name) {
  const v = cache[name];
  if (v != null && v !== "") return "panel";
  return process.env[name] ? "env" : "none";
}

async function set(name, value) {
  if (!NAMES.includes(name)) throw new Error("Ajuste no permitido: " + name);
  const db = database();
  await ensureTable(db);
  const v = String(value == null ? "" : value).trim();
  if (!v) {
    await db.sql`DELETE FROM gaso_settings WHERE name = ${name}`;
  } else {
    const stored = SECRET.has(name) ? enc(v) : v;
    await db.sql`
      INSERT INTO gaso_settings (name, value, updated_at) VALUES (${name}, ${stored}, NOW())
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
  }
  loadedAt = 0;
}

const mask = (v) => (v ? "••••" + String(v).slice(-4) : "");

module.exports = { NAMES, SECRET, load, get, source, set, mask };
