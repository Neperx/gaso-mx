const crypto = require("crypto");
const { sign, getSession, sameOrigin, resp, clientIp } = require("../lib/session");

const attempts = new Map(); // limitador básico por IP (por instancia; mitigación, no sustituye a un WAF)
const MAX_FAILS = 5, WINDOW_MS = 15 * 60 * 1000;

function loadUsers() {
  const users = [];
  const add = (u, p, role, fullName, email) => { if (u && p) users.push({ username: u, password: p, role, fullName, email: email || "" }); };
  add(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD, "SUPERADMIN", "Superusuario — Dirección General", process.env.ADMIN_EMAIL);
  add(process.env.VENTAS_USER, process.env.VENTAS_PASSWORD, "VENTAS", "Ejecutivo de Ventas");
  try {
    (JSON.parse(process.env.USERS_JSON || "[]") || []).forEach((u) => add(u.username, u.password, u.role === "SUPERADMIN" ? "SUPERADMIN" : (u.role || "VENTAS"), u.fullName || u.username, u.email));
  } catch (e) { /* USERS_JSON inválido: se ignora */ }
  return users;
}

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookie(value, maxAge) {
  return `gaso_session=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/` + (maxAge != null ? `; Max-Age=${maxAge}` : "");
}

exports.handler = async (event) => {
  if (!sameOrigin(event)) return resp(403, { ok: false, message: "Origen no permitido" });

  if (event.httpMethod === "GET") {
    let s = null;
    try { s = getSession(event); } catch (e) { return resp(500, { ok: false, message: e.message }); }
    return resp(200, s ? { ok: true, authenticated: true, remember: !!s.m, user: { username: s.u, role: s.r, fullName: s.n, email: s.e || "" } } : { ok: true, authenticated: false });
  }
  if (event.httpMethod !== "POST") return resp(405, { ok: false, message: "Método no permitido" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return resp(400, { ok: false, message: "JSON inválido" }); }

  if (body.action === "logout") return resp(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
  if (body.action === "ping") {
    // Renueva la sesión corta (30 min) mientras haya actividad; las sesiones "recordadas" no cambian
    let s = null;
    try { s = getSession(event); } catch (e) { return resp(500, { ok: false, message: e.message }); }
    if (!s) return resp(401, { ok: false, message: "Sesión expirada" });
    if (s.m) return resp(200, { ok: true, remember: true });
    const t = sign({ u: s.u, r: s.r, n: s.n, e: s.e, m: 0, exp: Math.floor(Date.now() / 1000) + 30 * 60 });
    return resp(200, { ok: true, remember: false }, { "Set-Cookie": cookie(t, 30 * 60) });
  }
  if (body.action !== "login") return resp(400, { ok: false, message: "Acción inválida" });

  const ip = clientIp(event), now = Date.now();
  const rec = attempts.get(ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_FAILS) {
    return resp(429, { ok: false, message: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." });
  }

  let users;
  try { sign({ t: 1 }); /* valida SESSION_SECRET */ users = loadUsers(); } catch (e) { return resp(500, { ok: false, message: "Servidor sin configurar: " + e.message }); }
  if (!users.length) return resp(500, { ok: false, message: "Servidor sin usuarios configurados (ADMIN_USER / ADMIN_PASSWORD)." });

  const uname = String(body.username || "").trim().toLowerCase().slice(0, 100);
  const pass = String(body.password || "").slice(0, 200);
  const found = users.find((u) => {
    const nameOk = safeEq(u.username.toLowerCase(), uname) || (u.email ? safeEq(u.email.toLowerCase(), uname) : false);
    const passOk = safeEq(u.password, pass); // siempre se evalúa (tiempo constante)
    return nameOk && passOk;
  });

  if (!found) {
    const r = rec && now - rec.first < WINDOW_MS ? rec : { count: 0, first: now };
    r.count++; attempts.set(ip, r);
    await sleep(400);
    return resp(401, { ok: false, message: "Usuario o contraseña incorrectos." });
  }
  attempts.delete(ip);

  const remember = !!body.remember;
  const ttl = remember ? 7 * 24 * 3600 : 30 * 60; // sin "recordar": 30 min, se renueva con actividad
  const token = sign({ u: found.username, r: found.role, n: found.fullName, e: found.email, m: remember ? 1 : 0, exp: Math.floor(now / 1000) + ttl });
  return resp(200, { ok: true, remember, user: { username: found.username, role: found.role, fullName: found.fullName, email: found.email } },
    { "Set-Cookie": cookie(token, ttl) });
};
