// Acceso al proveedor de IA (Gemini o Claude), compartido por varias funciones.
// Llaves/modelos: primero lo guardado en ⚙️ Configuración, si no, las variables de Netlify.
const settings = require("./settings");
const MODEL_RE = /^gemini-([0-9]+(\.[0-9]+)?-)?(flash|pro)(-[a-z0-9-]{1,20})?$/;
const DEFAULT_MODEL = "gemini-flash-latest"; // gemini-2.5-* ya fue dado de baja por Google

const ready = () => settings.load();
const provider = () => "gemini"; // solo Gemini (gratuito)
const configured = () => !!settings.get("GEMINI_API_KEY");
// Una llave propia (panel) usa el endpoint directo; la del AI Gateway de Netlify usa su URL base.
const geminiBase = () => (settings.source("GEMINI_API_KEY") === "panel" ? "https://generativelanguage.googleapis.com" : (process.env.GOOGLE_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com")).replace(/\/$/, "");
const anthropicBase = () => (settings.source("ANTHROPIC_API_KEY") === "panel" ? "https://api.anthropic.com" : (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com")).replace(/\/$/, "");
const errBody = (m) => JSON.stringify({ error: { message: m } });

async function geminiCall(model, prompt, key, signal, opts) {
  const gen = { temperature: opts.temperature == null ? 0.25 : opts.temperature, maxOutputTokens: opts.maxTokens || 8192 };
  if (opts.json) gen.responseMimeType = "application/json";
  return fetch(`${geminiBase()}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gen }),
    signal
  });
}

// Si el modelo ya no existe (404), busca el flash estable más nuevo que Google tenga disponible.
async function discoverFlashModel(key, skip, signal) {
  try {
    const r = await fetch(`${geminiBase()}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal });
    const d = await r.json();
    const list = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace("models/", ""))
      .filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n) && !skip.includes(n))
      .sort((a, b) => parseFloat(b.split("-")[1]) - parseFloat(a.split("-")[1]));
    return list[0] || null;
  } catch (e) { return null; }
}

// Devuelve { status, text } con el cuerpo original de Google.
async function geminiRaw(prompt, signal, opts = {}) {
  await ready();
  const key = settings.get("GEMINI_API_KEY");
  if (!key) return { status: 500, text: errBody("GEMINI_API_KEY no está configurada en Netlify.") };
  let model = settings.get("GEMINI_MODEL") || DEFAULT_MODEL; // el modelo lo decide el servidor
  if (!MODEL_RE.test(model)) return { status: 500, text: errBody("GEMINI_MODEL tiene un formato inválido") };
  // Si el modelo está saturado (503/429/500) o no existe (404), prueba los siguientes.
  const chain = [model, "gemini-flash-latest", "gemini-flash-lite-latest"].filter((m, i, a) => a.indexOf(m) === i);
  let last = null;
  for (const m of chain) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await geminiCall(m, prompt, key, ctl.signal, opts);
      const text = await r.text();
      last = { status: r.status, text };
      if (![404, 429, 500, 503].includes(r.status)) return last;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      last = { status: 504, text: errBody("El modelo " + m + " tardó demasiado en responder.") };
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
  }
  if (last.status === 404) {
    const next = await discoverFlashModel(key, chain, signal);
    if (next) {
      const r = await geminiCall(next, prompt, key, signal, opts);
      return { status: r.status, text: await r.text() };
    }
  }
  return last;
}

// Devuelve { status, data } con el JSON original de Anthropic.
async function anthropicRaw(prompt, signal, opts = {}) {
  await ready();
  const key = settings.get("ANTHROPIC_API_KEY");
  if (!key) return { status: 500, data: { error: { message: "ANTHROPIC_API_KEY no está configurada en Netlify." } } };
  const model = settings.get("AI_MODEL") || "claude-sonnet-5-5";
  // AI Gateway inyecta ANTHROPIC_BASE_URL; con llave propia se usa el endpoint directo.
  const base = anthropicBase();
  const r = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    // Los modelos Claude actuales rechazan "temperature", por eso no se envía.
    body: JSON.stringify({ model, max_tokens: opts.maxTokens || 8192, messages: [{ role: "user", content: prompt }] }),
    signal
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* no JSON */ }
  return { status: r.ok && !data.error ? 200 : (r.status || 502), data, model };
}

// Pregunta simple: devuelve { ok, text } o { ok:false, status, message }
async function askText(prompt, opts = {}) {
  await ready();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 20000);
  try {
    if (provider() === "anthropic") {
      const r = await anthropicRaw(prompt, ctl.signal, opts);
      if (r.status !== 200) return { ok: false, status: r.status, message: (r.data.error && r.data.error.message) || "Error del proveedor de IA" };
      return { ok: true, text: (r.data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("") };
    }
    const r = await geminiRaw(prompt, ctl.signal, opts);
    let d = {};
    try { d = JSON.parse(r.text); } catch (e) { /* no JSON */ }
    if (r.status !== 200) return { ok: false, status: r.status, message: (d.error && d.error.message) || "Error del proveedor de IA" };
    const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
    return { ok: true, text: parts.map((p) => p.text || "").join("") };
  } catch (e) {
    return { ok: false, status: e.name === "AbortError" ? 504 : 502, message: e.name === "AbortError" ? "La IA tardó demasiado" : "No se pudo contactar a la IA" };
  } finally { clearTimeout(timer); }
}

module.exports = { ready, provider, configured, geminiRaw, anthropicRaw, askText, DEFAULT_MODEL };
