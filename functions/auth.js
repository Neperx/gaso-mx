import { sign, getSession, sameOrigin, resp, clientIp } from "../lib/session.js";

const attempts = new Map();
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function loadUsers(env) {
  const users = [];
  const add = (u, p, role, fullName, email) => {
    if (u && p) users.push({ username: u, password: p, role, fullName, email: email || "" });
  };
  add(env.ADMIN_USER, env.ADMIN_PASSWORD, "SUPERADMIN", "Superusuario — Dirección General", env.ADMIN_EMAIL);
  add(env.VENTAS_USER, env.VENTAS_PASSWORD, "VENTAS", "Ejecutivo de Ventas");
  try {
    (JSON.parse(env.USERS_JSON || "[]") || []).forEach((u) =>
      add(
        u.username,
        u.password,
        u.role === "SUPERADMIN" ? "SUPERADMIN" : (u.role || "VENTAS"),
        u.fullName || u.username,
        u.email
      )
    );
  } catch (e) { /* USERS_JSON inválido: se ignora */ }
  return users;
}

async function digest(s) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeEq(a, b) {
  const ha = await digest(a);
  const hb = await digest(b);
  if (ha.length !== hb.length) return false;
  let result = 0;
  for (let i = 0; i < ha.length; i++) result |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return result === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookie(value, maxAge) {
  // SameSite=Lax: login same-origin OK; evita rarezas con Strict + recargas/tabs.
  // Secure + HttpOnly: la cookie no es legible desde JS (XSS).
  let c = `gaso_session=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  if (maxAge != null) {
    c += `; Max-Age=${maxAge}`;
    if (maxAge <= 0) c += "; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  }
  return c;
}

function requestHeaders(request) {
  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  return headers;
}

/** GET /auth — estado de sesión (cookie HttpOnly). */
export async function onRequestGet(context) {
  const env = context.env;
  const headers = requestHeaders(context.request);

  let s = null;
  try {
    s = await getSession({ headers }, env.SESSION_SECRET || "");
  } catch (e) {
    return resp(500, { ok: false, message: e.message });
  }

  if (s) {
    return resp(200, {
      ok: true,
      authenticated: true,
      remember: !!s.m,
      user: { username: s.u, role: s.r, fullName: s.n, email: s.e || "" }
    });
  }
  return resp(200, { ok: true, authenticated: false });
}

/**
 * POST /auth — body JSON:
 *   { action: "login", username, password, remember }
 *   { action: "logout" }
 *   { action: "ping" }
 */
export async function onRequestPost(context) {
  try {
    return await handleAuthPost(context);
  } catch (e) {
    return resp(500, { ok: false, message: "Error interno de auth: " + (e && e.message ? e.message : String(e)) });
  }
}

async function handleAuthPost(context) {
  const request = context.request;
  const env = context.env;
  const headers = requestHeaders(request);

  if (!(await sameOrigin({ headers }, env))) {
    return resp(403, { ok: false, message: "Origen no permitido" });
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return resp(400, { ok: false, message: "JSON inválido" });
  }

  if (body.action === "logout") {
    return resp(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
  }

  if (body.action === "ping") {
    let s = null;
    try {
      s = await getSession({ headers }, env.SESSION_SECRET || "");
    } catch (e) {
      return resp(500, { ok: false, message: e.message });
    }
    if (!s) return resp(401, { ok: false, message: "Sesión expirada" });
    if (s.m) return resp(200, { ok: true, remember: true });
    const t = await sign(
      { u: s.u, r: s.r, n: s.n, e: s.e, m: 0, exp: Math.floor(Date.now() / 1000) + 30 * 60 },
      env.SESSION_SECRET || ""
    );
    return resp(200, { ok: true, remember: false }, { "Set-Cookie": cookie(t, 30 * 60) });
  }

  if (body.action !== "login") {
    return resp(400, { ok: false, message: "Acción inválida" });
  }

  const ip = clientIp({ headers });
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_FAILS) {
    return resp(429, { ok: false, message: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." });
  }

  let users;
  try {
    await sign({ t: 1 }, env.SESSION_SECRET || "");
    users = loadUsers(env);
  } catch (e) {
    return resp(500, { ok: false, message: "Servidor sin configurar: " + e.message });
  }
  if (!users.length) {
    return resp(500, { ok: false, message: "Servidor sin usuarios configurados (ADMIN_USER / ADMIN_PASSWORD)." });
  }

  const uname = String(body.username || "").trim().toLowerCase().slice(0, 100);
  const pass = String(body.password || "").slice(0, 200);
  let found = null;
  for (const u of users) {
    const nameOk = (await safeEq(u.username.toLowerCase(), uname))
      || (u.email ? await safeEq(u.email.toLowerCase(), uname) : false);
    const passOk = await safeEq(u.password, pass);
    if (nameOk && passOk) { found = u; break; }
  }

  if (!found) {
    const r = rec && now - rec.first < WINDOW_MS ? rec : { count: 0, first: now };
    r.count++;
    attempts.set(ip, r);
    await sleep(400);
    return resp(401, { ok: false, message: "Usuario o contraseña incorrectos." });
  }
  attempts.delete(ip);

  const remember = !!body.remember;
  const ttl = remember ? 7 * 24 * 3600 : 30 * 60;
  const token = await sign(
    {
      u: found.username,
      r: found.role,
      n: found.fullName,
      e: found.email,
      m: remember ? 1 : 0,
      exp: Math.floor(now / 1000) + ttl
    },
    env.SESSION_SECRET || ""
  );

  return resp(
    200,
    {
      ok: true,
      remember,
      user: {
        username: found.username,
        role: found.role,
        fullName: found.fullName,
        email: found.email
      }
    },
    { "Set-Cookie": cookie(token, ttl) }
  );
}

