const NAMES = ["AI_PROVIDER","GEMINI_API_KEY","GEMINI_MODEL","ANTHROPIC_API_KEY","AI_MODEL","TECNO_API_TOKEN"];
const SECRET = new Set(["GEMINI_API_KEY","ANTHROPIC_API_KEY","TECNO_API_TOKEN"]);
const TTL_MS = 15000;

let cache = {};
let loadedAt = 0;

async function encKey(secret){
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode("gaso-settings:"+secret));
  return new Uint8Array(hash);
}
async function enc(text, secret){
  const k = await encKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encTxt = new TextEncoder().encode(String(text));
  const key = await crypto.subtle.importKey("raw", k, {name:"AES-GCM"}, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, encTxt);
  const all = new Uint8Array(iv.byteLength + ct.byteLength);
  all.set(new Uint8Array(iv)); all.set(new Uint8Array(ct), iv.byteLength);
  return "v1:" + btoa(String.fromCharCode(...all));
}
async function dec(s, secret){
  if(!s || !String(s).startsWith("v1:")) return "";
  const k = await encKey(secret);
  const raw = Uint8Array.from(atob(String(s).slice(3)), c=>c.charCodeAt(0));
  const iv = raw.slice(0,12); const ct = raw.slice(12);
  const key = await crypto.subtle.importKey("raw", k, {name:"AES-GCM"}, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, ct);
  return new TextDecoder().decode(pt);
}

async function load(db, force, secret){
  if(!force && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS gaso_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    const {results} = await db.prepare("SELECT name, value FROM gaso_settings").all();
    const m = {};
    (results || []).forEach(r => {
      try { m[r.name] = SECRET.has(r.name) ? dec(r.value, secret) : r.value; } catch(e){}
    });
    cache = m;
  } catch(e) {}
  loadedAt = Date.now();
  return cache;
}
function get(name){
  const v = cache[name];
  if(v != null && v !== "") return v;
  return "";
}
function source(name){
  const v = cache[name];
  if(v != null && v !== "") return "panel";
  return "none";
}
async function set(name, value, db, secret){
  if(!NAMES.includes(name)) throw new Error("Ajuste no permitido: "+name);
  await db.prepare("CREATE TABLE IF NOT EXISTS gaso_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  const v = String(value == null ? "" : value).trim();
  if(!v){
    await db.prepare("DELETE FROM gaso_settings WHERE name = ?1").bind(name).run();
  } else {
    const stored = SECRET.has(name) ? await enc(v, secret) : v;
    await db.prepare("INSERT INTO gaso_settings (name, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(name, stored).run();
  }
  loadedAt = 0;
}
function mask(v){ return v ? "••••"+String(v).slice(-4) : ""; }

export { NAMES, SECRET, load, get, source, set, mask };