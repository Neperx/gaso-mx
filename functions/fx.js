import { requireAuth, resp } from "../lib/session.js";
import { ensureFreshFx, loadFx } from "../lib/fx.js";

export async function onRequestGet(context) {
  const headers = {};
  context.request.headers.forEach((v, k) => { headers[k] = v; });
  const auth = await requireAuth({ headers }, context.env.SESSION_SECRET || "", context.env);
  if (auth.error) return auth.error;
  const url = new URL(context.request.url);
  const force = url.searchParams.get("refresh") === "1";
  try {
    if (force) {
      if (auth.session.r !== "SUPERADMIN") {
        return resp(403, { status: false, message: "Solo SUPERADMIN puede forzar el tipo de cambio." });
      }
      const fresh = await ensureFreshFx(context.env.DB, true);
      return resp(200, { status: true, ...fresh });
    }
    const cur = await loadFx(context.env.DB);
    if (cur) return resp(200, { status: true, ...cur, refreshed: false });
    const fresh = await ensureFreshFx(context.env.DB, true);
    return resp(200, { status: true, ...fresh });
  } catch (e) {
    return resp(500, { status: false, message: "FX: " + (e.message || String(e)) });
  }
}

export async function onRequestPost(context) {
  return onRequestGet(context);
}
