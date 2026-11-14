import settings from "./settings.js";

// Acepta modelos actuales de AI Studio / generateContent (flash, pro, hydrogen, etc.)
const MODEL_RE = /^gemini-[a-z0-9][a-z0-9.\-_]{1,80}$/i;
const DEFAULT_MODEL = "gemini-flash-latest";
const FALLBACK_MODELS = ["gemini-flash-latest", "gemini-2.0-flash", "gemini-flash-lite-latest"];

async function ready(env) {
  await settings.load(env && env.DB, false, (env && env.SESSION_SECRET) || "", env);
}
const provider = () => "gemini";
async function configured(env) {
  await ready(env);
  return !!(settings.get("GEMINI_API_KEY") || (env && env.GEMINI_API_KEY));
}
function resolveKey(name, env) {
  return settings.get(name) || (env && env[name]) || "";
}
const geminiBase = () => "https://generativelanguage.googleapis.com";
const errBody = (m) => JSON.stringify({ error: { message: m } });

async function geminiCall(model, prompt, key, signal, opts) {
  const gen = {
    temperature: opts.temperature == null ? 0.25 : opts.temperature,
    maxOutputTokens: opts.maxTokens || 8192
  };
  if (opts.json) gen.responseMimeType = "application/json";
  // REST generateContent (AI Studio API key). Docs: https://aistudio.google.com/docs/get-started
  return fetch(`${geminiBase()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: gen
    }),
    signal
  });
}

async function geminiRaw(prompt, signal, opts = {}, env) {
  await ready(env);
  const key = resolveKey("GEMINI_API_KEY", env);
  if (!key) return { status: 500, text: errBody("GEMINI_API_KEY no está configurada en Cloudflare.") };
  let model = settings.get("GEMINI_MODEL") || (env && env.GEMINI_MODEL) || DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) {
    return { status: 500, text: errBody("GEMINI_MODEL tiene un formato inválido: " + model) };
  }
  const chain = [model, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);
  let last = null;
  for (const m of chain) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await geminiCall(m, prompt, key, ctl.signal, opts);
      const text = await r.text();
      last = { status: r.status, text, model: m };
      if (![404, 429, 500, 503].includes(r.status)) return last;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      last = { status: 504, text: errBody("El modelo " + m + " tardó demasiado en responder."), model: m };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  if (last && last.status === 404) {
    const next = await discoverFlashModel(key, chain, signal);
    if (next) {
      const r = await geminiCall(next, prompt, key, signal, opts);
      return { status: r.status, text: await r.text(), model: next };
    }
  }
  return last;
}

async function discoverFlashModel(key, skip, signal) {
  try {
    const r = await fetch(`${geminiBase()}/v1beta/models?pageSize=200`, {
      headers: { "x-goog-api-key": key },
      signal
    });
    const d = await r.json();
    const list = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter((n) => /flash/i.test(n) && !skip.includes(n))
      .sort((a, b) => b.length - a.length);
    return list[0] || null;
  } catch (e) {
    return null;
  }
}

async function anthropicRaw(prompt, signal, opts = {}, env) {
  await ready(env);
  const key = resolveKey("ANTHROPIC_API_KEY", env);
  if (!key) {
    return { status: 500, data: { error: { message: "ANTHROPIC_API_KEY no está configurada en Cloudflare." } } };
  }
  const model = settings.get("AI_MODEL") || (env && env.AI_MODEL) || "claude-sonnet-5-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 8192,
      messages: [{ role: "user", content: prompt }]
    }),
    signal
  });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  return { status: r.ok && !data.error ? 200 : (r.status || 502), data, model };
}

async function askText(prompt, opts = {}, env) {
  await ready(env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 20000);
  try {
    if (provider() === "anthropic") {
      const r = await anthropicRaw(prompt, ctl.signal, opts, env);
      if (r.status !== 200) {
        return { ok: false, status: r.status, message: (r.data.error && r.data.error.message) || "Error del proveedor de IA" };
      }
      return {
        ok: true,
        text: (r.data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")
      };
    }
    const r = await geminiRaw(prompt, ctl.signal, opts, env);
    let d = {};
    try { d = JSON.parse(r.text); } catch (e) {}
    if (r.status !== 200) {
      return { ok: false, status: r.status, message: (d.error && d.error.message) || "Error del proveedor de IA" };
    }
    const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
    return { ok: true, text: parts.map((p) => p.text || "").join(""), model: r.model };
  } catch (e) {
    return {
      ok: false,
      status: e.name === "AbortError" ? 504 : 502,
      message: e.name === "AbortError" ? "La IA tardó demasiado" : "No se pudo contactar a la IA"
    };
  } finally {
    clearTimeout(timer);
  }
}

export { ready, provider, configured, geminiRaw, anthropicRaw, askText, DEFAULT_MODEL };
export default { ready, provider, configured, geminiRaw, anthropicRaw, askText, DEFAULT_MODEL };
