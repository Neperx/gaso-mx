import { resp } from "../lib/session.js";

/**
 * Webhook para recibir notificaciones de Mercado Pago (IPN / Webhooks v2)
 * URL: https://gaso-mx.pages.dev/api/webhook-mp (o /functions/webhook-mp.js)
 */
export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    // A veces Mercado Pago envía notification vía query params
  }

  const url = new URL(request.url);
  const topic = url.searchParams.get("topic") || body.type || body.action;
  const id = url.searchParams.get("id") || (body.data && body.data.id);

  // Obtener Access Token de Cloudflare
  let accessToken = env.MP_ACCESS_TOKEN || "";
  if (!accessToken && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT value FROM gaso_settings WHERE name = 'MP_ACCESS_TOKEN'").first();
      if (row && row.value) accessToken = row.value.trim();
    } catch (e) {}
  }

  // Si es evento de pago aprobado, consultar detalle y actualizar estado en D1 si existe
  if ((topic === "payment" || topic === "payment.created" || topic === "payment.updated") && id && accessToken) {
    try {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (mpRes.ok) {
        const paymentData = await mpRes.json();
        const status = paymentData.status; // 'approved', 'pending', 'rejected', etc.
        const externalRef = paymentData.external_reference; // Folio de la cotización, ej: COT-2026-001

        if (status === "approved" && externalRef && env.DB) {
          // Actualizar estado de la cotización en D1 a 'approved' si existe
          try {
            await env.DB.prepare(
              "UPDATE gaso_quotes SET status = 'approved', updated_at = datetime('now') WHERE number = ?1"
            ).bind(externalRef).run();
          } catch (eDb) {}
        }
      }
    } catch (err) {
      console.warn("Error al procesar webhook de Mercado Pago:", err);
    }
  }

  // Mercado Pago requiere responder inmediatamente 200/201 OK para no reintentar
  return resp(200, { ok: true, received: true });
}

export async function onRequestGet(context) {
  return resp(200, { ok: true, message: "Webhook endpoint activo para Mercado Pago." });
}
