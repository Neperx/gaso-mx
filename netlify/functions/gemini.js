// Asistente interno (requiere sesión). Sintaxis v2 para que el runtime moderno inyecte
// las credenciales de Netlify AI Gateway (Claude). El proveedor lo elige el usuario en el
// cotizador ("gemini" o "anthropic"); si no lo manda, se usa AI_PROVIDER.
// La respuesta siempre se devuelve en el formato de Gemini para que el cotizador no cambie.
import session from "../lib/session.js";
import llm from "../lib/llm.js";

const { requireAuth } = session;

const MAX_PROMPT = 60000;
const json = (status, obj) => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export default async (req) => {
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const auth = requireAuth({ headers, httpMethod: req.method });
  if (auth.error) return new Response(auth.error.body, { status: auth.error.statusCode, headers: auth.error.headers });
  if (req.method !== "POST") return json(405, { error: { message: "Método no permitido" } });

  let b = {};
  try { b = await req.json(); } catch (e) { return json(400, { error: { message: "JSON inválido" } }); }
  const prompt = String(b.prompt || "");
  if (!prompt || prompt.length > MAX_PROMPT) return json(400, { error: { message: "Prompt vacío o demasiado largo" } });
  // Opciones acotadas: el cotizador puede pedir respuesta JSON, respuestas cortas o más creatividad.
  const opts = { json: b.json === true };
  const mt = parseInt(b.maxTokens, 10);
  if (mt >= 256 && mt <= 8192) opts.maxTokens = mt;
  const temp = parseFloat(b.temperature);
  if (temp >= 0 && temp <= 1) opts.temperature = temp;
  await llm.ready();
  const provider = llm.provider(); // lo decide ⚙️ Configuración (servidor), no el navegador

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    if (provider === "anthropic") {
      const r = await llm.anthropicRaw(prompt, ctl.signal, opts);
      if (r.status !== 200) return json(r.status, { error: { message: "Claude: " + ((r.data.error && r.data.error.message) || "error del proveedor de IA") } });
      const text = (r.data.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
      return json(200, { candidates: [{ content: { parts: [{ text }] } }], modelUsed: r.model, provider });
    }
    const r = await llm.geminiRaw(prompt, ctl.signal, opts);
    if (r.status !== 200) {
      let m = "error del proveedor de IA";
      try { m = JSON.parse(r.text).error.message || m; } catch (e) { /* no JSON */ }
      return json(r.status, { error: { message: "Gemini: " + m } });
    }
    return json(200, r.text);
  } catch (err) {
    const timeout = err.name === "AbortError";
    return json(timeout ? 504 : 502, { error: { message: timeout ? "La IA tardó demasiado en responder" : "No se pudo contactar al proveedor de IA" } });
  } finally { clearTimeout(timer); }
};
