import { requireAuth, resp } from "./session.js";

/**
 * Endpoint para generar Links de Pago y Códigos QR con Mercado Pago
 * Utiliza la API oficial de Mercado Pago (Checkout Pro / Orders / Preferences)
 */
export default async function mercadopagoHandler(request, env) {
  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });

  const auth = await requireAuth({ headers }, env.SESSION_SECRET || "", env);
  if (auth.error) {
    return auth.error;
  }

  // Obtener Access Token: primero de DB (gaso_settings), luego de env
  let accessToken = env.MP_ACCESS_TOKEN || "";
  const db = env.DB;
  if (db) {
    try {
      const row = await db.prepare("SELECT value FROM gaso_settings WHERE name = 'MP_ACCESS_TOKEN'").first();
      if (row && row.value) {
        // Si está cifrado con formato v1:, descifrarlo usando SESSION_SECRET
        let val = row.value.trim();
        if (val.startsWith("v1:")) {
          try {
            const secret = env.SESSION_SECRET || "";
            const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gaso-settings:" + secret));
            const k = new Uint8Array(hash);
            const raw = Uint8Array.from(atob(val.slice(3)), (c) => c.charCodeAt(0));
            const iv = raw.slice(0, 12);
            const ct = raw.slice(12);
            const key = await crypto.subtle.importKey("raw", k, { name: "AES-GCM" }, false, ["decrypt"]);
            const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
            val = new TextDecoder().decode(pt);
          } catch (eDec) {}
        }
        if (val) accessToken = val;
      }
    } catch (e) {}
  }

  if (!accessToken) {
    return resp(400, {
      ok: false,
      message: "No está configurado el Access Token de Mercado Pago. Configúralo en la pestaña de ⚙️ Configuración."
    });
  }

  const method = request.method.toUpperCase();

  // POST: Crear preferencia o link de pago
  if (method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return resp(400, { ok: false, message: "JSON inválido." });
    }

    const { quoteNumber, clientName, clientEmail, total, items, backUrl } = body;

    const amount = parseFloat(total);
    if (!amount || amount <= 0) {
      return resp(400, { ok: false, message: "El total de la cotización debe ser mayor a 0." });
    }

    const title = `Cotización ${quoteNumber || 'GASO'} - GASO Ingeniería`;
    const description = `Servicios y equipos de ingeniería para ${clientName || 'Cliente'}`;

    // Payload compatible con Mercado Pago Preferences / Checkout Pro
    const mpPayload = {
      items: [
        {
          id: quoteNumber || "COT-01",
          title: title.slice(0, 255),
          description: description.slice(0, 255),
          quantity: 1,
          currency_id: "MXN",
          unit_price: amount
        }
      ],
      payer: {
        name: (clientName || "Cliente").slice(0, 50),
        email: (clientEmail && clientEmail.includes("@")) ? clientEmail : "contacto@gaso.mx"
      },
      external_reference: quoteNumber || ("COT-" + Date.now()),
      statement_descriptor: "GASO ING",
      back_urls: {
        success: backUrl || "https://gaso-mx.pages.dev",
        failure: backUrl || "https://gaso-mx.pages.dev",
        pending: backUrl || "https://gaso-mx.pages.dev"
      },
      auto_return: "approved",
      notification_url: "https://gaso-mx.pages.dev/webhook-mp"
    };

    try {
      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(mpPayload)
      });

      const mpData = await mpRes.json();

      if (!mpRes.ok) {
        return resp(mpRes.status, {
          ok: false,
          message: "Error de Mercado Pago: " + (mpData.message || JSON.stringify(mpData))
        });
      }

      // Link de pago oficial en Producción (o sandbox de respaldo si el token es de prueba)
      const isTestToken = accessToken.startsWith("TEST-");
      const checkoutUrl = (!isTestToken && mpData.init_point) ? mpData.init_point : (mpData.init_point || mpData.sandbox_init_point);
      const isProduction = !isTestToken && Boolean(mpData.init_point);
      const preferenceId = mpData.id;

      return resp(200, {
        ok: true,
        preferenceId,
        checkoutUrl,
        isProduction,
        total: amount,
        quoteNumber
      });
    } catch (err) {
      return resp(500, {
        ok: false,
        message: "Error de conexión con Mercado Pago: " + err.message
      });
    }
  }

  // GET: Prueba de conexión
  if (method === "GET") {
    try {
      const testRes = await fetch("https://api.mercadopago.com/users/me", {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      const userData = await testRes.json();
      if (testRes.ok) {
        return resp(200, {
          ok: true,
          message: "Conexión exitosa con Mercado Pago.",
          user: {
            id: userData.id,
            nickname: userData.nickname,
            email: userData.email,
            site_id: userData.site_id
          }
        });
      }
      return resp(testRes.status, {
        ok: false,
        message: "Token inválido o expirado en Mercado Pago: " + (userData.message || "")
      });
    } catch (err) {
      return resp(500, { ok: false, message: "Error al probar token: " + err.message });
    }
  }

  return resp(405, { ok: false, message: "Método no permitido." });
}
