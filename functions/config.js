import session from "../lib/session.js";
import * as settings from "../lib/settings.js";
import * as llm from "../lib/llm.js";

const { requireAuth } = session;

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

function toEvent(req) {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  return { headers, httpMethod: req.method };
}

const chk = (name, ok, detail, fix) => ({ name, ok, detail, fix: ok ? "" : (fix || "") });
const secretsList = (env) =>
  settings.NAMES.filter((n) => settings.SECRET.has(n)).map((n) => settings.get(n)).concat([env.SESSION_SECRET]);
const snippet = (txt, env) => {
  let t = String(txt || "").replace(/\s+/g, " ").slice(0, 220);
  secretsList(env).filter(Boolean).forEach((s) => { t = t.split(s).join("***"); });
  return t;
};
const MODEL_RE = /^[a-z0-9][a-z0-9.\-_]{1,60}$/i;

async function testGemini(env) {
  if (!settings.get("GEMINI_API_KEY") && !env.GEMINI_API_KEY) {
    return chk("Gemini", false, "No hay llave de Gemini.", "Pega tu llave de Google AI Studio en ⚙️ Configuración → Inteligencia Artificial y guarda.");
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await llm.geminiRaw("Responde solo: OK", ctl.signal, { maxTokens: 64 }, env);
    if (r.status === 200) return chk("Gemini", true, "Responde correctamente (llave " + settings.source("GEMINI_API_KEY") + ").");
    const d = snippet(r.text, env);
    if (r.status === 401 || r.status === 403 || /API key/i.test(d)) {
      return chk("Gemini", false, `Google rechazó la llave (HTTP ${r.status}): ${d}`, "Crea una llave nueva en aistudio.google.com/apikey y pégala en Configuración.");
    }
    if (r.status === 404) {
      return chk("Gemini", false, `Modelo no disponible: ${d}`, "Cambia el modelo en Configuración (deja el campo vacío para usar gemini-flash-latest).");
    }
    if (r.status === 429) {
      return chk("Gemini", false, `Límite de uso alcanzado: ${d}`, "Espera unos minutos o revisa la cuota en Google AI Studio.");
    }
    return chk("Gemini", false, `Error HTTP ${r.status}: ${d}`, "Revisa el detalle en Google AI Studio.");
  } catch (e) {
    return chk("Gemini", false, "Sin conexión con Google (" + (e.name === "AbortError" ? "tiempo agotado" : e.message) + ").", "Reintenta en un momento.");
  } finally {
    clearTimeout(t);
  }
}

async function testAnthropic(env) {
  if (!settings.get("ANTHROPIC_API_KEY") && !env.ANTHROPIC_API_KEY) {
    return chk("Claude", false, "No hay llave de Claude.", "Pega tu llave de console.anthropic.com en ⚙️ Configuración y guarda.");
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await llm.anthropicRaw("Responde solo: OK", ctl.signal, { maxTokens: 64 }, env);
    if (r.status === 200) return chk("Claude", true, "Responde correctamente.");
    const d = snippet(JSON.stringify(r.data || {}), env);
    return chk("Claude", false, `Error HTTP ${r.status}: ${d}`, "Revisa tu llave de Anthropic.");
  } catch (e) {
    return chk("Claude", false, "Sin conexión con Anthropic (" + (e.name === "AbortError" ? "tiempo agotado" : e.message) + ").", "Reintenta en un momento.");
  } finally {
    clearTimeout(t);
  }
}

async function testTecno(env) {
  const token = settings.get("TECNO_API_TOKEN") || env.TECNO_API_TOKEN || "";
  if (!token) {
    return chk("Tecnosinergia", false, "No hay token de Tecnosinergia.", "Pégalo en ⚙️ Configuración → Tecnosinergia y guarda.");
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch("https://api.tecnosinergia.info/v3/status", {
        method: "GET",
        headers: { Accept: "application/json", "Content-Type": "application/json", "api-token": token },
        signal: ctl.signal
      });
      const text = await r.text();
      if (r.status === 200) return chk("Tecnosinergia", true, "Responde correctamente.");
      return chk("Tecnosinergia", false, `HTTP ${r.status}: ${text.slice(0, 100)}`, "Verifica el token en Cloudflare.");
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return chk("Tecnosinergia", false, e.name === "AbortError" ? "Tiempo de espera agotado" : e.message, "Verifica conectividad.");
  }
}

async function testDb(env) {
  try {
    await env.DB.prepare("SELECT 1 AS ok").all();
    return chk("Base de datos D1", true, "Conexión a D1 exitosa.");
  } catch (e) {
    return chk("Base de datos D1", false, String(e.message || e), "Verifica que la base D1 esté vinculada al proyecto.");
  }
}

async function testCatalogs(env) {
  const counts = {};
  try {
    const r = await env.DB.prepare("SELECT name, COALESCE(SUM(n),0) AS total FROM gaso_catalog_parts GROUP BY name").all();
    (r.results || []).forEach((x) => { counts[x.name] = x.total; });
  } catch (e) { /* tabla aún no existe */ }
  const ok = !!(counts.syscom && counts.ct);
  return chk(
    "Catálogos Syscom / CT",
    ok,
    ok
      ? `Syscom: ${counts.syscom?.toLocaleString?.("es-MX") ?? counts.syscom} · CT: ${counts.ct?.toLocaleString?.("es-MX") ?? counts.ct} productos.`
      : "Faltan catálogos en D1.",
    "Impórtalos en ⚙️ Configuración → Catálogos Syscom / CT."
  );
}

function status(env) {
  const out = {};
  settings.NAMES.forEach((n) => {
    const secret = settings.SECRET.has(n);
    const fromPanel = settings.get(n);
    const fromEnv = env[n] || "";
    const v = fromPanel || fromEnv;
    const source = fromPanel ? "panel" : (fromEnv ? "env" : "none");
    out[n] = { source, secret, value: secret ? settings.mask(v) : v };
  });
  return out;
}

function validate(name, v) {
  if (name === "AI_PROVIDER") return v === "gemini" || v === "anthropic" ? "" : "Proveedor inválido";
  if (name === "GEMINI_MODEL" || name === "AI_MODEL") return MODEL_RE.test(v) ? "" : "Nombre de modelo inválido";
  return /^[\x21-\x7E]{8,400}$/.test(v) ? "" : "La llave debe tener 8-400 caracteres sin espacios";
}

async function handle(context) {
  const request = context.request;
  const env = context.env;
  const auth = await requireAuth(toEvent(request), env.SESSION_SECRET || "", env);
  if (auth.error) return auth.error;
  const s = auth.session;
  if (s.r !== "SUPERADMIN") {
    return json(403, { status: false, message: "Solo el superusuario puede abrir la configuración." });
  }

  await settings.load(env.DB, true, env.SESSION_SECRET || "", env);

  if (request.method === "GET") return json(200, { status: true, settings: status(env) });
  if (request.method !== "POST") return json(405, { status: false, message: "Método no permitido" });

  let b = {};
  try {
    b = await request.json();
  } catch (e) {
    return json(400, { status: false, message: "JSON inválido" });
  }

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
        await settings.set(n, v, env.DB, env.SESSION_SECRET || "");
      }
      for (const n of clear) {
        if (settings.NAMES.includes(n)) await settings.set(n, "", env.DB, env.SESSION_SECRET || "");
      }
    } catch (e) {
      return json(500, { status: false, message: "No se pudo guardar: " + e.message });
    }
    await settings.load(env.DB, true, env.SESSION_SECRET || "", env);
    return json(200, { status: true, settings: status(env) });
  }

  if (b.op === "test") {
    const t = String(b.target || "all");
    const runs = {
      gemini: () => testGemini(env),
      anthropic: () => testAnthropic(env),
      tecno: () => testTecno(env),
      db: () => testDb(env),
      catalogs: () => testCatalogs(env)
    };
    let checks;
    if (t === "all") {
      const provider = llm.provider();
      checks = [
        chk("Sesión y login en servidor", true, "Funcionando (sesión de " + s.u + ")."),
        provider === "anthropic" ? await testAnthropic(env) : await testGemini(env),
        await testTecno(env),
        await testDb(env),
        await testCatalogs(env)
      ];
    } else if (runs[t]) {
      checks = [await runs[t]()];
    } else {
      return json(400, { status: false, message: "Prueba desconocida" });
    }
    return json(200, { status: true, allOk: checks.every((c) => c.ok), checks });
  }

  return json(400, { status: false, message: "Operación inválida" });
}

export async function onRequestGet(context) {
  return handle(context);
}

export async function onRequestPost(context) {
  return handle(context);
}
