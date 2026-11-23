import { resp } from "../lib/session.js";

/**
 * Validador criptográfico HMAC-SHA256 para x-signature de Mercado Pago Webhook v2
 */
async function verifyMercadoPagoSignature(request, dataId, webhookSecret) {
  if (!webhookSecret) return true;
  const xSig = request.headers.get("x-signature");
  const xReqId = request.headers.get("x-request-id") || "";
  if (!xSig) return false;

  const parts = {};
  xSig.split(",").forEach((part) => {
    const [k, v] = part.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  });

  const ts = parts.ts;
  const hash = parts.v1;
  if (!ts || !hash) return false;

  const manifest = `id:${dataId || ""};request-id:${xReqId};ts:${ts};`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(manifest));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.toLowerCase() === hash.toLowerCase();
}

/**
 * Webhook para recibir notificaciones de Mercado Pago (IPN / Webhooks v2)
 * URL: https://gaso-mx.pages.dev/webhook-mp (o /api/webhook-mp)
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

  // Obtener Access Token y Webhook Secret de Cloudflare o D1
  let accessToken = env.MP_ACCESS_TOKEN || "";
  let webhookSecret = env.MP_WEBHOOK_SECRET || "";
  if ((!accessToken || !webhookSecret) && env.DB) {
    try {
      const rows = await env.DB.prepare(
        "SELECT name, value FROM gaso_settings WHERE name IN ('MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET')"
      ).all();
      (rows.results || []).forEach((r) => {
        if (r.name === "MP_ACCESS_TOKEN" && !accessToken) accessToken = r.value.trim();
        if (r.name === "MP_WEBHOOK_SECRET" && !webhookSecret) webhookSecret = r.value.trim();
      });
    } catch (e) {}
  }

  // Si existe firma secreta configurada, verificar x-signature
  if (webhookSecret && id) {
    const isSigValid = await verifyMercadoPagoSignature(request, id, webhookSecret);
    if (!isSigValid) {
      console.warn("Firma de webhook Mercado Pago no coincide o es inválida.");
      return resp(401, { ok: false, message: "Firma inválida." });
    }
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
