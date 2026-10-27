// ⚙️ Configuración y diagnóstico de conexiones (solo SUPERADMIN, requiere sesión).
//   GET            -> estado de cada ajuste (las llaves nunca se devuelven, solo "••••1234")
//   POST op=save   -> guarda/borra ajustes (cifrados en la base de datos)
//   POST op=test   -> prueba una conexión: gemini | anthropic | tecno | db | catalogs | all
import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "@netlify/database";
import session from "../lib/session.js";
import settings from "../lib/settings.js";
import llm from "../lib/llm.js";

const { requireAuth } = session;
const here = process.cwd();

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const toResponse = (r) => new Response(r.body, { status: r.statusCode, headers: r.headers });
function toEvent(req) {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  return { headers, httpMethod: req.method };
}

const chk = (name, ok, detail, fix) => ({ name, ok, detail, fix: ok ? "" : (fix || "") });
const secretsList = () => settings.NAMES.filter((n) => settings.SECRET.has(n)).map((n) => settings.get(n)).concat([process.env.SESSION_SECRET]);
const snippet = (txt) => {
  let t = String(txt || "").replace(/\s+/g, " ").slice(0, 220);
  secretsList().filter(Boolean).forEach((s) => { t = t.split(s).join("***"); });
  return t;
};
const MODEL_RE = /^[a-z0-9][a-z0-9.\-_]{1,60}$/i;

async function timed(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); } finally { clearTimeout(t); }
}

async function testGemini() {
  if (!settings.get("GEMINI_API_KEY")) return chk("Gemini", false, "No hay llave de Gemini.", "Pega tu llave de Google AI Studio en ⚙️ Configuración → Inteligencia Artificial y guarda.");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await llm.geminiRaw("Responde solo: OK", ctl.signal, { maxTokens: 64 });
    if (r.status === 200) return chk("Gemini", true, "Responde correctamente (llave " + settings.source("GEMINI_API_KEY") + ").");
    const d = snippet(r.text);
    if (r.status === 401 || r.status === 403 || /API key/i.test(d)) return chk("Gemini", false, `Google rechazó la llave (HTTP ${r.status}): ${d}`, "Crea una llave nueva en aistudio.google.com/apikey y pégala en Configuración.");
    if (r.status === 404) return chk("Gemini", false, `Modelo no disponible: ${d}`, "Cambia el modelo en Configuración (deja el campo vacío para usar gemini-flash-latest).");
    if (r.status === 429) return chk("Gemini", false, `Límite de uso alcanzado: ${d}`, "Espera unos minutos o revisa la cuota en Google AI Studio.");
    return chk("Gemini", false, `Error HTTP ${r.status}: ${d}`, "Revisa el detalle en Google AI Studio.");
  } catch (e) {
    return chk("Gemini", false, "Sin conexión con Google (" + (e.name === "AbortError" ? "tiempo agotado" : e.message) + ").", "Reintenta en un momento.");
  } finally { clearTimeout(t); }
}

async function testAnthropic() {
  if (!settings.get("ANTHROPIC_API_KEY")) return chk("Claude", false, "No hay llave de Claude.", "Pega tu llave de console.anthropic.com en ⚙️ Configuración y guarda.");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await llm.anthropicRaw("Responde solo: OK", ctl.signal, { maxTokens: 64 });
    if (r.status === 200) return chk("Claude", true, `Responde correctamente (modelo ${r.model}).`);
    const m = snippet((r.data.error && r.data.error.message) || "");
    return chk("Claude", false, `HTTP ${r.status}: ${m}`, r.status === 401 ? "Llave inválida: genera otra en console.anthropic.com." : r.status === 404 ? "Revisa el nombre del modelo de Claude." : "Revisa saldo/cuota en console.anthropic.com.");
  } catch (e) {
    return chk("Claude", false, "Sin conexión (" + (e.name === "AbortError" ? "tiempo agotado" : e.message) + ").", "Reintenta.");
  } finally { clearTimeout(t); }
}

async function testTecno() {
  const token = settings.get("TECNO_API_TOKEN");
  if (!token) return chk("Tecnosinergia", false, "No hay token de Tecnosinergia.", "Pégalo en ⚙️ Configuración → Tecnosinergia y guarda.");
  try {
    const r = await timed("https://api.tecnosinergia.info/v3/status", { headers: { Accept: "application/json", "Content-Type": "application/json", "api-token": token } });
    const txt = await r.text();
    let d = null;
    try { d = JSON.parse(txt); } catch (e) { /* no JSON */ }
    if (d && d.status === false && Number(d.code) === 100) return chk("Tecnosinergia", false, "Token rechazado (token invalid).", "Pide un token vigente a Tecnosinergia y guárdalo en Configuración.");
    return r.ok ? chk("Tecnosinergia", true, "La API responde (HTTP " + r.status + ").") : chk("Tecnosinergia", false, `HTTP ${r.status}: ${snippet(txt)}`, r.status === 401 || r.status === 403 ? "Token rechazado: pide uno nuevo." : "Reintenta o contacta a su soporte.");
  } catch (e) { return chk("Tecnosinergia", false, "Sin conexión (" + (e.name === "AbortError" ? "tiempo agotado" : e.message) + ").", "Reintenta."); }
}

async function testDb() {
  try {
    const db = getDatabase();
    const c = await db.sql`SELECT COUNT(*)::int AS n FROM gaso_clients`;
    const q = await db.sql`SELECT COUNT(*)::int AS n FROM gaso_quotes`;
    return chk("Base de datos (clientes y notas)", true, `Conectada: ${c[0].n} clientes y ${q[0].n} cotizaciones guardadas en la nube.`);
  } catch (e) { return chk("Base de datos (clientes y notas)", false, "No disponible: " + snippet(e.message), "Vuelve a desplegar el sitio completo; Netlify crea las tablas al desplegar."); }
}

async function testCatalogs() {
  const counts = { syscom: 0, ct: 0 };
  try {
    const db = getDatabase();
    const r = await db.sql`SELECT name, COALESCE(SUM(n),0)::int AS total FROM gaso_catalog_parts GROUP BY name`;
    r.forEach((x) => { counts[x.name] = x.total; });
  } catch (e) { /* tabla aún no existe */ }
  const ok = !!(counts.syscom && counts.ct);
  return chk("Catálogos Syscom / CT", ok, ok ? `Syscom: ${counts.syscom.toLocaleString("es-MX")} · CT: ${counts.ct.toLocaleString("es-MX")} productos (en la base de datos).` : `Faltan catálogos en la base de datos (Syscom: ${counts.syscom}, CT: ${counts.ct}).`, "Impórtalos en ⚙️ Configuración → Catálogos Syscom / CT.");
}

function status() {
  const out = {};
  settings.NAMES.forEach((n) => {
    const secret = settings.SECRET.has(n);
    const v = settings.get(n);
    out[n] = { source: settings.source(n), secret, value: secret ? settings.mask(v) : v };
  });
  return out;
}

function validate(name, v) {
  if (name === "AI_PROVIDER") return v === "gemini" || v === "anthropic" ? "" : "Proveedor inválido";
  if (name === "GEMINI_MODEL" || name === "AI_MODEL") return MODEL_RE.test(v) ? "" : "Nombre de modelo inválido";
  return /^[\x21-\x7E]{8,400}$/.test(v) ? "" : "La llave debe tener 8-400 caracteres sin espacios";
}

export default async (req) => {
  const auth = requireAuth(toEvent(req));
  if (auth.error) return toResponse(auth.error);
  if (auth.session.r !== "SUPERADMIN") return json(403, { status: false, message: "Solo el superusuario puede abrir la configuración." });
  await settings.load(true);

  if (req.method === "GET") return json(200, { status: true, settings: status() });
  if (req.method !== "POST") return json(405, { status: false, message: "Método no permitido" });

  let b = {};
  try { b = await req.json(); } catch (e) { return json(400, { status: false, message: "JSON inválido" }); }

  if (b.op === "save") {
    const values = b.values && typeof b.values === "object" ? b.values : {};
    const clear = Array.isArray(b.clear) ? b.clear : [];
    try {
      for (const n of Object.keys(values)) {
        if (!settings.NAMES.includes(n) || settings.SECRET.has(n)) continue;
        const v = String(values[n] == null ? "" : values[n]).trim().replace(/^["']|["']$/g, "");
        if (!v) continue;
        const err = validate(n, v);
        if (err) return json(400, { status: false, message: n + ": " + err });
        await settings.set(n, v);
      }
      for (const n of clear) if (settings.NAMES.includes(n)) await settings.set(n, "");
    } catch (e) { return json(500, { status: false, message: "No se pudo guardar: " + e.message }); }
    await settings.load(true);
    return json(200, { status: true, settings: status() });
  }

  if (b.op === "test") {
    const t = String(b.target || "all");
    const runs = {
      gemini: testGemini, anthropic: testAnthropic, tecno: testTecno, db: testDb, catalogs: async () => testCatalogs()
    };
    let checks;
    if (t === "all") {
      const provider = llm.provider();
      checks = [
        chk("Sesión y login en servidor", true, "Funcionando (sesión de " + auth.session.u + ")."),
        provider === "anthropic" ? await testAnthropic() : await testGemini(),
        await testTecno(), await testDb(), await testCatalogs()
      ];
    } else if (runs[t]) checks = [await runs[t]()];
    else return json(400, { status: false, message: "Prueba desconocida" });
    return json(200, { status: true, allOk: checks.every((c) => c.ok), checks });
  }

  return json(400, { status: false, message: "Operación inválida" });
};
