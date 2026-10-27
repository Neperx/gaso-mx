const crypto = require("crypto");

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET no configurado (mínimo 32 caracteres)");
  return s;
}
const hmac = (body) => crypto.createHmac("sha256", secret()).update(body).digest("base64url");

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + hmac(body);
}

function verify(token) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch (e) { return null; }
}

function parseCookies(h) {
  const out = {};
  String(h || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function getSession(event) {
  const h = event.headers || {};
  return verify(parseCookies(h.cookie || h.Cookie).gaso_session);
}

// Solo acepta peticiones originadas en el mismo sitio (anti-CSRF / anti uso desde otros dominios)
// Comparación tolerante: los encabezados pueden llegar con mayúsculas distintas según el
// proxy/versión HTTP, y host puede traer o no el puerto. Se acepta si el hostname del
// Origin coincide con CUALQUIERA de los hosts declarados en la petición (algunos proxies
// ponen en x-forwarded-host el nombre interno y en host el público, o viceversa).
function header(h, name) {
  const want = String(name).toLowerCase();
  for (const k of Object.keys(h || {})) {
    if (k.toLowerCase() === want) return h[k];
  }
  return undefined;
}

function normHostname(v) {
  return String(v == null ? "" : v).split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function sameOrigin(event) {
  const h = event.headers || {};
  const origin = header(h, "origin");
  if (!origin || origin === "null") return true; // navegación misma-pestaña sin Origin, o archivo local
  let oHost;
  try { oHost = new URL(String(origin)).hostname.toLowerCase().replace(/\.$/, ""); } catch (e) { return false; }
  if (!oHost) return false;
  const candidates = [
    header(h, "x-forwarded-host"),
    header(h, "host"),
    header(h, "x-forwarded-server"),
    header(h, "x-original-host")
  ]
    .filter(Boolean)
    .flatMap((v) => String(v).split(","))
    .map(normHostname)
    .filter(Boolean);
  const referer = header(h, "referer");
  if (referer) {
    try { candidates.push(new URL(String(referer)).hostname.toLowerCase().replace(/\.$/, "")); } catch (e) { /* se ignora */ }
  }
  // Lista blanca opcional para dominios propios adicionales (separados por coma en ALLOWED_ORIGINS)
  String(process.env.ALLOWED_ORIGINS || "").split(",").map(normHostname).filter(Boolean).forEach((x) => candidates.push(x));
  if (!candidates.length) return true; // sin host con qué comparar: la cookie SameSite=Strict sigue protegiendo
  return candidates.includes(oHost);
}

function resp(status, obj, headers) {
  return {
    statusCode: status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers || {}),
    body: typeof obj === "string" ? obj : JSON.stringify(obj)
  };
}

function clientIp(event) {
  const h = event.headers || {};
  return h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

// Exige sesión válida + mismo origen. Devuelve {session} o {error: respuesta}
function requireAuth(event) {
  if (!sameOrigin(event)) return { error: resp(403, { status: false, message: "Origen no permitido" }) };
  let s;
  try { s = getSession(event); } catch (e) { return { error: resp(500, { status: false, message: "Servidor sin configurar: " + e.message }) }; }
  if (!s) return { error: resp(401, { status: false, message: "Sesión requerida" }) };
  return { session: s };
}

module.exports = { sign, verify, getSession, sameOrigin, resp, clientIp, requireAuth };
