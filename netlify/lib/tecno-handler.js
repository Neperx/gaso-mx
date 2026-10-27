const { requireAuth, resp } = require("./session");
const settings = require("./settings");

const HOST = "api.tecnosinergia.info";
// Solo rutas de lectura/sincronización necesarias para el cotizador
const ALLOWED = /^\/v3\/(status|item\/list|items|products|catalogo)\/?$/;

exports.handler = async (event) => {
  const auth = requireAuth(event);
  if (auth.error) return auth.error;

  const method = event.httpMethod;
  if (method !== "GET" && method !== "POST") return resp(405, { status: false, message: "Método no permitido" });

  const qs = event.queryStringParameters || {};
  let path = String(qs.path || "/v3/item/list");
  if (!path.startsWith("/")) path = "/" + path;
  let url;
  try { url = new URL(path, "https://" + HOST); } catch (e) { return resp(400, { status: false, message: "Ruta inválida" }); }
  if (url.host !== HOST || !ALLOWED.test(url.pathname) || path.length > 300) {
    return resp(403, { status: false, message: "Ruta no permitida" });
  }

  // El token vive en el servidor (⚙️ Configuración o variable TECNO_API_TOKEN); nunca viaja desde el navegador.
  await settings.load();
  const token = settings.get("TECNO_API_TOKEN");
  if (!token) return resp(500, { status: false, message: "No hay token de Tecnosinergia: agrégalo como variable TECNO_API_TOKEN en Netlify." });

  // La API v3 solo acepta GET (POST responde 405), así que siempre se consulta con GET.
  // Se reenvían los parámetros extra (p. ej. paginación) además de "path".
  for (const [k, v] of Object.entries(qs)) {
    if (k !== "path" && v != null && String(v).length <= 100) url.searchParams.set(k, String(v));
  }

  const hdrs = { Accept: "application/json", "Content-Type": "application/json", "api-token": token };
  let r, text, lastErr;
  try {
    // Un reintento ante fallas transitorias (red o 5xx) para que la actualización no falle "a veces".
    // La lista completa (/v3/item/list) no tiene paginación y es pesada: un solo intento con más tiempo.
    const heavy = url.pathname.indexOf("/item/list") === 0 || /\/v3\/item\/list/.test(url.pathname);
    for (let attempt = 0; attempt < (heavy ? 1 : 2); attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), heavy ? 24000 : attempt === 0 ? 14000 : 10000);
      try {
        // Content-Type es obligatorio: sin él la API responde "header error" (código 130) aunque el token sea válido.
        r = await fetch(url.toString(), { method: "GET", headers: hdrs, signal: ctl.signal });
        text = await r.text();
        if (r.status < 500) break;
      } catch (e) { lastErr = e; r = null; } finally { clearTimeout(timer); }
    }
    if (!r) throw lastErr || new Error("sin respuesta");
    // La API a veces responde HTML (p. ej. página 404) o texto no-JSON según la ruta.
    // Siempre se devuelve JSON: el cuerpo cuando es JSON válido,
    // o un sobre de error con el HTTP real y un fragmento para diagnosticar.
    let parsed = null, isJson = false;
    try { parsed = JSON.parse(text); isJson = true; } catch (e) { /* no es JSON */ }
    if (isJson) {
      if (parsed && parsed.status === false && Number(parsed.code) === 100) {
        return resp(401, {
          status: false, code: 100, route: url.pathname,
          message: "Tecnosinergia rechazó el token (token invalid). Actualiza TECNO_API_TOKEN en las variables de Netlify."
        });
      }
      // Catálogos completos pueden superar el límite de respuesta de las funciones (~6 MB):
      // se reenvían solo los campos que usa el cotizador.
      const slim = slimList(parsed);
      return resp(r.status, slim ? { status: true, route: url.pathname, total: slim.length, items: slim } : parsed);
    }
    const snippet = String(text || "").replace(/\s+/g, " ").slice(0, 200);
    return resp(r.status >= 400 ? r.status : 502, {
      status: false,
      message: "Tecnosinergia respondió HTTP " + r.status + " en " + url.pathname + " sin JSON válido" + (snippet ? ": " + snippet : "."),
      upstreamStatus: r.status,
      route: url.pathname
    });
  } catch (err) {
    return resp(err.name === "AbortError" ? 504 : 502, { status: false, message: err.name === "AbortError" ? "Tiempo de espera agotado consultando " + url.pathname : "No se pudo contactar a Tecnosinergia" });
  }
};

const LIST_KEYS = ["items", "data", "productos", "products", "catalogo", "resultado", "result", "results", "content", "list", "lista", "rows", "records", "articulos", "articles"];
// Campos que lee el importador del cotizador (parseAndImportStoreJSON)
const KEEP = ["code", "item_code", "modelo", "model", "sku", "codigo", "clave", "part_number", "item_id", "producto_id", "sat_code", "stock_total", "active",
  "titulo", "descripcion", "description", "name", "producto", "nombre", "marca", "brand", "brand_name", "trademark", "fabricante",
  "categoria", "category", "category_name", "linea", "line", "satCode", "clave_sat", "sat_key", "codigo_sat", "sat",
  "satDesc", "descripcion_sat", "precio_distribuidor", "precio_descuento", "sale_price", "regular_price", "price",
  "precio_lista", "precio", "precio_1", "costo", "moneda", "currency", "currency_code", "existencia", "stock"];

function findList(obj) {
  if (Array.isArray(obj)) return obj.length && obj.every((x) => x && typeof x === "object") ? obj : null;
  if (!obj || typeof obj !== "object") return null;
  for (const k of LIST_KEYS) if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k of LIST_KEYS) if (Array.isArray(v[k]) && v[k].length) return v[k];
    }
  }
  return null;
}

function slimList(obj) {
  const list = findList(obj);
  if (!list) return null;
  return list.filter((x) => x && typeof x === "object").map((it) => {
    const o = {};
    for (const k of KEEP) {
      const v = it[k];
      if (v == null || v === "") continue;
      if (typeof v === "object") {
        // marca/categoría pueden venir como objeto {name: ...}
        const n = v.name || v.nombre || v.descripcion || v.title;
        if (n) o[k] = String(n);
        continue;
      }
      o[k] = typeof v === "string" && v.length > 400 ? v.slice(0, 400) : v;
    }
    return o;
  });
}

exports.slimList = slimList;
