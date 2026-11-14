import { requireAuth, resp } from "./session.js";
import settings from "./settings.js";

const HOST = "api.tecnosinergia.info";
// Rutas oficiales API v3 usadas por el cotizador (status + catálogo).
const ALLOWED = /^\/v3\/(status|item\/list|items|products|catalogo)\/?$/;

export default async function tecnoHandler(request, env){
  const headers = {}; request.headers.forEach((v,k)=>{headers[k]=v;});
  const auth = await requireAuth({headers}, env.SESSION_SECRET || "", env);
  if(auth.error) return auth.error;

  const url = new URL(request.url);
  let path = url.searchParams.get("path") || "/v3/item/list";
  // Si llega URL completa, quedarnos solo con el path+query.
  if(/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = u.pathname + (u.search || "");
    } catch (e) { /* keep path */ }
  }
  if(!path.startsWith("/")) path = "/" + path;
  let target;
  try { target = new URL(path, "https://" + HOST); } catch(e){ return resp(400, { status: false, message: "Ruta inválida" }); }
  if(target.host !== HOST || !ALLOWED.test(target.pathname) || path.length > 300){
    return resp(403, { status: false, message: "Ruta no permitida: " + target.pathname });
  }

  await settings.load(env.DB, false, env.SESSION_SECRET || "", env);
  // Preferir secret de Cloudflare; si el cliente manda un token real (modal), usarlo para prueba.
  const headerToken = headers["api-token"] || headers["Api-Token"] || "";
  const clientToken = headerToken && headerToken !== "server-managed" ? String(headerToken).trim() : "";
  const token = settings.get("TECNO_API_TOKEN") || env.TECNO_API_TOKEN || clientToken || "";
  if(!token) return resp(500, { status: false, message: "No hay token de Tecnosinergia: agregalo como secret TECNO_API_TOKEN en Cloudflare." });

  for(const [k,v] of url.searchParams){
    if(k !== "path" && v != null && String(v).length <= 100) target.searchParams.set(k, String(v));
  }
  const hdrs = { Accept: "application/json", "Content-Type": "application/json", "api-token": token };
  let r, text, lastErr;
  try {
    const heavy = target.pathname.indexOf("/item/list") === 0;
    for(let attempt = 0; attempt < (heavy ? 1 : 2); attempt++){
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), heavy ? 24000 : attempt === 0 ? 14000 : 10000);
      try {
        r = await fetch(target.toString(), { method: "GET", headers: hdrs, signal: ctl.signal });
        text = await r.text();
        if(r.status < 500) break;
      } catch(e){ lastErr = e; r = null; } finally { clearTimeout(timer); }
    }
    if(!r) throw lastErr || new Error("sin respuesta");
    let parsed = null, isJson = false;
    try { parsed = JSON.parse(text); isJson = true; } catch(e){}
    if(isJson){
      if(parsed && parsed.status === false && Number(parsed.code) === 100){
        return resp(401, { status: false, code: 100, route: target.pathname, message: "Tecnosinergia rechazó el token (token invalid). Actualiza TECNO_API_TOKEN en Cloudflare." });
      }
      const slim = slimList(parsed);
      return resp(r.status, slim ? { status: true, route: target.pathname, total: slim.length, items: slim } : parsed);
    }
    const snippet = String(text || "").replace(/\s+/g, " ").slice(0,200);
    return resp(r.status >= 400 ? r.status : 502, { status: false, message: "Tecnosinergia respondió HTTP " + r.status + " en " + target.pathname + " sin JSON válido" + (snippet ? ": " + snippet : "."), upstreamStatus: r.status, route: target.pathname });
  } catch(err){
    return resp(err.name === "AbortError" ? 504 : 502, { status: false, message: err.name === "AbortError" ? "Tiempo de espera agotado consultando " + target.pathname : "No se pudo contactar a Tecnosinergia" });
  }
};
const LIST_KEYS = ["items","data","productos","products","catalogo","resultado","result","results","content","list","lista","rows","records","articulos","articles"];
const KEEP = ["code","item_code","modelo","model","sku","codigo","clave","part_number","item_id","producto_id","sat_code","stock_total","active","titulo","descripcion","description","name","producto","nombre","marca","brand","brand_name","trademark","fabricante","categoria","category","category_name","linea","line","satCode","clave_sat","sat_key","codigo_sat","sat","satDesc","descripcion_sat","precio_distribuidor","precio_descuento","sale_price","regular_price","price","precio_lista","precio","precio_1","costo","moneda","currency","currency_code","existencia","stock"];
function findList(obj){
  if(Array.isArray(obj)) return obj.length && obj.every(x => x && typeof x === "object") ? obj : null;
  if(!obj || typeof obj !== "object") return null;
  for(const k of LIST_KEYS) if(Array.isArray(obj[k]) && obj[k].length) return obj[k];
  for(const v of Object.values(obj)){
    if(v && typeof v === "object" && !Array.isArray(v)){
      for(const k of LIST_KEYS) if(Array.isArray(v[k]) && v[k].length) return v[k];
    }
  }
  return null;
}
function slimList(obj){
  const list = findList(obj);
  if(!list) return null;
  return list.filter(x => x && typeof x === "object").map(it => {
    const o = {};
    for(const k of KEEP){
      const v = it[k];
      if(v == null || v === "") continue;
      if(typeof v === "object"){
        const n = v.name || v.nombre || v.descripcion || v.title;
        if(n) o[k] = String(n);
        continue;
      }
      o[k] = typeof v === "string" && v.length > 400 ? v.slice(0,400) : v;
    }
    return o;
  });
}
export { slimList };