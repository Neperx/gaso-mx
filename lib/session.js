const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function base64urlEncode(str) {
  // btoa solo acepta Latin1: hay que pasar UTF-8 como bytes (nombres con acentos/emdash).
  const bytes = ENCODER.encode(String(str));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

function base64urlDecodeToUtf8(str) {
  const bin = base64urlDecode(str);
  const bytes = Uint8Array.from(bin, (m) => m.codePointAt(0));
  return DECODER.decode(bytes);
}

function requireSecret(secret) {
  if (secret == null || secret === "") {
    throw new Error("SESSION_SECRET ausente en context.env (revisa Secrets de Pages y vuelve a desplegar)");
  }
  if (String(secret).length < 32) {
    throw new Error("SESSION_SECRET demasiado corto (" + String(secret).length + " chars; mínimo 32)");
  }
  return String(secret);
}

async function hmacSha256Hex(key, data) {
  // Cloudflare exige hash en el AlgorithmIdentifier de HMAC (no basta el string "HMAC").
  const algo = { name: "HMAC", hash: "SHA-256" };
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(key),
    algo,
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(algo, cryptoKey, ENCODER.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(payload, secret) {
  const key = requireSecret(secret);
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = await hmacSha256Hex(key, body);
  return body + "." + sig;
}

async function verify(token, secret) {
  if (!token || typeof token !== "string") return null;
  const key = requireSecret(secret);
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmacSha256Hex(key, body);
  if (sig !== expected) return null;
  try {
    const p = JSON.parse(base64urlDecodeToUtf8(body));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function parseCookies(h) {
  const out = {};
  String(h || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

async function getSession(event, secret) {
  const h = event.headers || {};
  const cookie = h.cookie || h.Cookie || "";
  const parsed = parseCookies(cookie);
  return await verify(parsed.gaso_session, secret);
}

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

async function sameOrigin(event, env = {}) {
  const h = event.headers || {};
  const origin = header(h, "origin");
  if (!origin || origin === "null") return true;
  let oHost;
  try {
    oHost = new URL(String(origin)).hostname.toLowerCase().replace(/\.$/, "");
  } catch (e) {
    return false;
  }
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
    try {
      candidates.push(new URL(String(referer)).hostname.toLowerCase().replace(/\.$/, ""));
    } catch (e) { /* ignore */ }
  }

  const allowedOrigins = (env && env.ALLOWED_ORIGINS) || "";
  allowedOrigins.split(",").map(normHostname).filter(Boolean).forEach((x) => candidates.push(x));

  if (!candidates.length) return true;
  return candidates.includes(oHost);
}

function resp(status, obj, headers) {
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      headers || {}
    )
  });
}

function clientIp(event) {
  const h = event.headers || {};
  return (
    header(h, "cf-connecting-ip")
    || header(h, "x-nf-client-connection-ip")
    || (header(h, "x-forwarded-for") || "").split(",")[0].trim()
    || "unknown"
  );
}

async function requireAuth(event, secret, env = {}) {
  if (!(await sameOrigin(event, env))) {
    return { error: await resp(403, { status: false, message: "Origen no permitido" }) };
  }
  let s;
  try {
    s = await getSession(event, secret);
  } catch (e) {
    return { error: await resp(500, { status: false, message: "Servidor sin configurar: " + e.message }) };
  }
  if (!s) return { error: await resp(401, { status: false, message: "Sesión requerida" }) };
  return { session: s };
}

export { sign, verify, getSession, sameOrigin, resp, clientIp, requireAuth };

export default { sign, verify, getSession, sameOrigin, resp, clientIp, requireAuth };
