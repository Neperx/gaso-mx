import session from "../lib/session.js";
import llm from "../lib/llm.js";

const { requireAuth } = session;

const MAX_PROMPT = 60000;
const json = (status, obj) => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "", env);
  if (auth.error) return auth.error;
  if (request.method !== "POST") return json(405, { error: { message: "Método no permitido" } });

  let b = {};
  try { b = await request.json(); } catch (e) { return json(400, { error: { message: "JSON inválido" } }); }
  const prompt = String(b.prompt || "");
  if (!prompt || prompt.length > MAX_PROMPT) return json(400, { error: { message: "Prompt vacío o demasiado largo" } });

  const opts = { json: b.json === true };
  const mt = parseInt(b.maxTokens, 10);
  if (mt >= 256 && mt <= 8192) opts.maxTokens = mt;
  const temp = parseFloat(b.temperature);
  if (temp >= 0 && temp <= 1) opts.temperature = temp;

  await llm.ready(env);
  const provider = llm.provider();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    if (provider === "anthropic") {
      const r = await llm.anthropicRaw(prompt, ctl.signal, opts, env);
      if (r.status !== 200) return json(r.status, { error: { message: "Claude: " + ((r.data.error && r.data.error.message) || "error del proveedor de IA") } });
      const text = (r.data.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
      return json(200, { candidates: [{ content: { parts: [{ text }] } }], modelUsed: r.model, provider });
    }
    const r = await llm.geminiRaw(prompt, ctl.signal, opts, env);
    if (r.status !== 200) {
      let m = "error del proveedor de IA";
      try { m = JSON.parse(r.text).error.message || m; } catch (e) { /* no JSON */ }
      return json(r.status, { error: { message: "Gemini: " + m } });
    }
    // r.text ya es JSON del proveedor: no volver a stringify
    return new Response(r.text, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  } catch (err) {
    const timeout = err.name === "AbortError";
    return json(timeout ? 504 : 502, { error: { message: timeout ? "La IA tardó demasiado en responder" : "No se pudo contactar al proveedor de IA" } });
  } finally { clearTimeout(timer); }
}